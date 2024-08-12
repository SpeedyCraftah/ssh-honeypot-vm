import { spawn, ChildProcessWithoutNullStreams } from "child_process";
import { config, logger } from "./index";
import { ImageDescriptor } from "./images";
import fs from "fs/promises";
import pidStat from "pidusage";
import { randomUUID } from "crypto";

export const vmInstances: VMInstance[] = [];

export default class VMInstance {
    private child?: ChildProcessWithoutNullStreams;
    public port: number;
    private _vmMonitorInterval?: NodeJS.Timeout;
    private _expireTimer?: NodeJS.Timeout;
    public running: boolean;
    public image: ImageDescriptor;
    public backedImagePath?: string;
    public starting: boolean;

    public readyAwait?: Promise<void>;
    private _readyAwaitResolve?: () => void;

    constructor(image: ImageDescriptor) {
        this.port = 0;
        this.running = false;
        this.image = image;
        this.starting = false;

        // Have a promise clients can hook into to wait for the VM to start.
        this.readyAwait = new Promise((resolve) => {
            this._readyAwaitResolve = resolve;
        });
    }

    private _startMonitorInterval() {
        if (this._vmMonitorInterval) throw new Error("VM monitor is already running!");
        if (!this.child) throw new Error("VM process is not running!");

        let highCPUStrikes = 0;
        let highCPUWarning = false;
        this._vmMonitorInterval = setInterval(async () => {
            if (!this.child || !this.child.pid) throw new Error("VM monitor called, but child is not running or doesn't exist!"); 

            const stat = await pidStat(this.child?.pid);
            const avgCoreUsage = stat.cpu / config.vm.cpus;

            // If the average CPU usage across all cores is 40% or above, add a strike.
            if (avgCoreUsage >= config.vm.monitor.high_cpu_threshold) {
                ++highCPUStrikes;

                // Machine is in a warning state.
                if (highCPUStrikes === config.vm.monitor.high_cpu_warning_strikes && !highCPUWarning) {
                    highCPUWarning = true;
                    logger.info(`[VM MONITOR] virtual machine with PID ${this.child.pid} | SSH port ${this.port} has used ${config.vm.monitor.high_cpu_threshold}% or more CPU over an extended period of time, it will be killed if it continues`);
                }

                // Kill the virtual machine.
                else if (highCPUStrikes >= config.vm.monitor.high_cpu_kill_strikes) {
                    this.child.kill("SIGTERM");

                    // Forcefully kill the process if it doesn't exit gracefully.
                    setTimeout(() => {
                        if (this.running) this.child?.kill("SIGKILL");
                    }, 2000);

                    logger.info(`[VM MONITOR] terminated virtual machine with PID ${this.child.pid} | SSH port ${this.port} for excessive CPU usage`);
                }
            } else {
                if (highCPUStrikes > 0) --highCPUStrikes;
                else if (highCPUWarning) highCPUWarning = false;
            }
        }, 500);
    }

    private _setupEvents() {
        if (!this.child) throw new Error("VM process is not running!");
        
        this.child.once("exit", code => {
            if (this._readyAwaitResolve) this._readyAwaitResolve();

            if (this._vmMonitorInterval) {
                clearInterval(this._vmMonitorInterval);
                delete this._vmMonitorInterval;
            }

            if (this._expireTimer) {
                clearTimeout(this._expireTimer);
                delete this._expireTimer;
            }

            if (code === 1) logger.warn(`Virtual machine process under SSH port ${this.port} has exited in an errored state`);
            else logger.info(`Virtual machine process under SSH port ${this.port} has shut down (status ${code})`);

            this.running = false;
            this.port = 0;
            delete this.child;
        });
    }

    public stop(force = false) {
        if (!this.running) throw new Error("VM stop requested, but not running");
        logger.debug(`Stopping virtual machine under SSH port ${this.port}..`);

        this.child?.kill(force ? "SIGKILL" : "SIGTERM");
    }

    public destroy() {
        return new Promise((resolve, reject) => {
            if (this.running) {
                this.child?.once("exit", () => {
                    // Clean-up the VM image.
                    if (this.backedImagePath) {
                        fs.rm(this.backedImagePath);
                        delete this.backedImagePath;
                        resolve(null);
                    }
                });
    
                this.child?.kill("SIGTERM");
    
                // Forcefully kill the process if it doesn't exit gracefully.
                setTimeout(() => {
                    if (this.running) this.child?.kill("SIGKILL");
                }, 2000);
            } else {
                if (this.backedImagePath) {
                    fs.rm(this.backedImagePath);
                    delete this.backedImagePath;
                    resolve(null);
                }
            }
        });
    }

    async start(expireMs?: number) {
        if (this.running) return;
        this.starting = true;

        // Create the backed image copy only if one doesn't already exist for this VM instance (new start).
        if (!this.backedImagePath) {
            // Create a mirror of the image.
            const backedImageName = `${randomUUID()}.qcow2`;
            this.backedImagePath = `${config.temp_directory}/ssh-honeypot-vm/${backedImageName}`;

            //const backedImageCreateResult = await checkCMDFailure(exec(`qemu-img create -b "${this.image.path}" -f qcow2 "${this.backedImagePath}" -F qcow2`));
            const backedImageCreateResult = await fs.copyFile(this.image.path, this.backedImagePath).then(() => true).catch(() => false);
            if (!backedImageCreateResult) {
                logger.fatal("Could not create a shadow image for the virtual machine due to error");
                process.exit(1);
            }

            logger.debug(`Created a shadow image for virtual machine under ${backedImageName}`);
        }

        // Find the first available port for the SSH server.
        let child!: ChildProcessWithoutNullStreams;
        let port = Number(config.ssh.port_forward_range.start);
        while (true) {
            logger.debug(`Trying port ${port} for VM SSH server..`);
            const result: boolean = await (new Promise((resolve, reject) => {
                let vmOptions = ["-boot", "c", "-cpu", "Skylake-Client-v1", "-smp", config.vm.cpus.toString(), "-m", config.vm.memory, "-display", "none", "-nic", "none", "-drive", `file=${this.backedImagePath},media=disk,if=virtio`, "-netdev", `user,id=n1${config.vm.allowNetworking ? "" : ",restrict=yes"},hostfwd=tcp::${port}-:22`, "-device", "e1000,netdev=n1"];
                if (this.image.snapshotPresent) vmOptions = [...vmOptions, "-loadvm", "snapshot"];

                child = spawn("qemu-system-x86_64", vmOptions);
                
                // After 250ms, assume the launch was successful.
                const successTimeout = setTimeout(() => {
                    child.stderr.removeAllListeners("data");
                    resolve(true);
                }, 250);

                child.stderr.on("data", (d: Buffer) => {
                    const errorLog = d.toString();
                    if (errorLog.includes("warning")) return;

                    // If the error is due to the port already being in use.
                    if (errorLog.includes(`tcp::${port}-:22`)) {
                        clearTimeout(successTimeout);
                        resolve(false);
                    }
                    
                    else {
                        clearTimeout(successTimeout);
                        logger.fatal(`Problem starting virtual machine: ${errorLog}`);
                        process.exit(1);
                    }
                });
            }));

            if (result) break;
            else ++port;
        }

        this.port = port;
        this.child = child;
        this._setupEvents();
        this._startMonitorInterval();

        // Whether the virtual machine should terminate after a set amount of time.
        if (expireMs) {
            this._expireTimer = setTimeout(() => {
                logger.debug(`Allocated time for virtual machine under SSH port ${this.port} has expired, terminating..`);
                this.stop();
            }, expireMs);
        }
        
        if (this.readyAwait && this._readyAwaitResolve) {
            this._readyAwaitResolve();
            delete this._readyAwaitResolve;
            delete this.readyAwait;
        }

        this.starting = false;
        this.running = true;
        logger.info(`Spawned virtual machine (PID ${child.pid}) with SSH forwarded to port ${port}` + (expireMs ? `, set to terminate after ${Math.floor(expireMs / 1000)} second(s)` : ""));
    }
};