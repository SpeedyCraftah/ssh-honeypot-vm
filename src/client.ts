import { config, logger } from ".";
import VMInstance from "./vm-instance";
import SSH2, { PseudoTtyInfo } from "ssh2";
import fs from "fs";
import fsP from "fs/promises";

const ZERO_BYTE_UINTARRAY = new Uint8Array([0]);

export default class Client {
    public ip: string;

    private dataDirectory: string;

    public vmInstance: VMInstance;
    private sshPtyInfo?: PseudoTtyInfo;

    public connectingClient: SSH2.Connection;
    public connectingSession: SSH2.Session;
    public connectingShell?: SSH2.ServerChannel;

    public proxySSHClientReady: boolean;
    public proxySSHClient?: SSH2.Client;
    public proxySSHStream?: SSH2.ClientChannel;

    constructor(client: SSH2.Connection, ip: string, session: SSH2.Session, vmInstance: VMInstance) {
        this.connectingClient = client;
        this.connectingSession = session;
        this.vmInstance = vmInstance;
        this.ip = ip;
        this.proxySSHClientReady = false;
        this.dataDirectory = `${config.data_directory}/${ip}`;
        
        this._setupClient();
    }

    // Closes any existing connections, and stops the VM instance if one is running and requested.
    public cleanup(stopVm = true) {
        if (this.connectingClient) this.connectingClient?.end();
        if (this.proxySSHClient) this.proxySSHClient.end();

        if (this.vmInstance && stopVm && this.vmInstance.running) this.vmInstance.stop();
    }

    private async setupLogs() {
        // Ensure the IP directory exists.
        await fsP.mkdir(this.dataDirectory).catch((error) => {
            if (error.code !== "EEXIST") {
                logger.fatal(`Could not create the client log directory! ${error.code} on ${error.path}`);
                process.exit(1);
            }
        });
    }

    private async ensureSSHConnection(): Promise<boolean> {
        if (this.proxySSHClient && this.proxySSHClientReady) return true;

        // Ensure the VM is started before proceeding.
        if (!this.vmInstance.running) {
            if (this.vmInstance.starting) await this.vmInstance.readyAwait;
            else await this.vmInstance.start();
        }

        return await (new Promise((resolve, reject) => {
            if (!this.proxySSHClient) {
                this.proxySSHClient = new SSH2.Client();

                // Setup events for new proxy SSH client.
                this.proxySSHClient.once("error", error => {
                    this.proxySSHClientReady = false;
                    logger.error(`Error occurred while setting up an SSH connection to the proxy for IP ${this.ip}: ${error}`);
                    this.cleanup();
                });

                this.proxySSHClient.once("ready", () => {
                    this.proxySSHClientReady = true;
                    this.proxySSHClient?.removeAllListeners("error");
                    resolve(true);
                });

                // Misc.
                this.proxySSHClient.on("end", () => {
                    logger.debug(`Proxy shell connection to client ${this.ip} has been closed`);
                    this.connectingClient.end();
                    this.proxySSHClientReady = false;
                    delete this.proxySSHClient;
                });
        
                this.proxySSHClient.connect({
                    host: "127.0.0.1",
                    port: this.vmInstance.port,
                    username: "root",
                    password: "root123"
                });
            } else {
                // Wait for the client to become ready.
                this.proxySSHClient.once("ready", () => {
                    resolve(true);
                });

                this.proxySSHClient.once("error", () => {
                    resolve(false);
                });
            }
        }));
    }

    async _handleSingleExec(stream: SSH2.ServerChannel, command: string) {
        // Setup the SSH connection.
        const connectionResult = await this.ensureSSHConnection();
        if (!connectionResult) return;

        logger.debug(`Client ${this.ip} is executing '${command}'`);
        this.proxySSHClient?.exec(command, (error, channel) => {
            const runtimeStartTime = Date.now();
            let execStdoutLogs = "";

            // Pipe all outputs to the stream.
            channel.stdout.pipe(stream.stdout);
            channel.stderr.pipe(stream.stderr);

            // Save the log entry on exit.
            channel.on("exit", code => {
                let execLogEntry = `---- Executed "${command}" at ${new Date().toISOString()} | Status Code = ${code} | Runtime = ${((Date.now() - runtimeStartTime) / 1000).toFixed(1)}s ----\n\n`;
                execLogEntry += execStdoutLogs;
                execLogEntry += `\n---- End of executed command ----\n\n`;

                // Append the result to the file.
                fsP.appendFile(`${this.dataDirectory}/EXEC.log`, execLogEntry);
            });

            const handleStdoutChunk = (data: Buffer) => {
                execStdoutLogs += data.toString("utf8");

                // Stop listening for further chunks if we've reached the chunk limit.
                if (execStdoutLogs.length >= config.logging.exec_max_stdout_entry) {
                    channel.stdout.removeListener("data", handleStdoutChunk);
                    channel.stderr.removeListener("data", handleStdoutChunk);
                    execStdoutLogs += "\n...TRUNCATED...";
                }
            }

            // Hook the actual data and save to log entry.
            channel.stdout.on("data", handleStdoutChunk);
            channel.stderr.on("data", handleStdoutChunk);
        });
    }

    async _handleInteractiveShell() {
        if (!this.connectingShell) throw new Error("No shell connection present!");
        this.connectingShell.stdout.write("\x1b[0;32mWelcome to the intermediary server!\x1b[0m\r\nPassing you through to an SSH server now..\r\n\r\n");

        // Setup the SSH connection.
        const connectionResult = await this.ensureSSHConnection();
        if (!connectionResult) return;

        this.proxySSHClient?.shell(this.sshPtyInfo || false, async (error, proxyStream) => {
            if (!this.connectingShell) throw new Error("No shell connection present!");

            if (error) {
                logger.error("Error while establishing a shell with proxy:", error);
                this.proxySSHClient?.destroy();
                this.connectingClient.end();
                return;
            } else this.proxySSHStream = proxyStream;

            logger.debug(`Successfully started a proxy shell session for VM`);

            // Ensure log directory is setup.
            await this.setupLogs();

            // This handle is used for logging all bytes and sequences entered and returned from the SSH connection.
            // It can be replayed in a terminal to reconstruct the session.
            const sshReplayLogHandle = fs.createWriteStream(`${this.dataDirectory}/SSH-REPLAY-${new Date().toISOString().replaceAll(/[:.]/g, "-")}-${this.sshPtyInfo?.cols}x${this.sshPtyInfo?.rows}.log`, { autoClose: true, encoding: "binary" });

            // Passthrough window size changes to proxy.
            this.connectingSession.on("window-change", (accept, reject, info) => {
                proxyStream.setWindow(info.rows, info.cols, info.height, info.width);
                if (accept) accept();
            });

            // Pipe the stdout's and stdin's bi-directionally.
            // This is done natively and is much faster and responsive compared to using the "data" event.
            proxyStream.stdout.pipe(this.connectingShell.stdout);
            proxyStream.stderr.pipe(this.connectingShell.stderr);
            this.connectingShell.stdin.pipe(proxyStream.stdin);

            let totalWrittenBytes = 0;
            const stdoutChunkHandler = (data: Buffer) => {
                sshReplayLogHandle.cork();
                sshReplayLogHandle.write(ZERO_BYTE_UINTARRAY)
                sshReplayLogHandle.write(data);
                sshReplayLogHandle.uncork();

                totalWrittenBytes += data.byteLength + 1;

                // Stop further logging if the session limit was reached.
                if (totalWrittenBytes >= config.logging.ssh_session_replay.max_replay_size) {
                    proxyStream.stdout.removeListener("data", stdoutChunkHandler);
                    proxyStream.stderr.removeListener("data", stdoutChunkHandler);
                    sshReplayLogHandle.close();

                    // Stop the VM and client if configured to do so after reaching log limit.
                    if (config.logging.ssh_session_replay.terminate_vm_on_max_replay_size) this.cleanup();
                }
            }

            // Log the actual bytes going in and out of the SSH connection.
            proxyStream.stdout.on("data", stdoutChunkHandler);
            proxyStream.stderr.on("data", stdoutChunkHandler);

            // If the client exits the SSH connection, proxy this as well.
            proxyStream.on("exit", () => {
                this.connectingShell?.end();
                sshReplayLogHandle.close();
            });
        });
    }

    async _setupClient() {
        this.connectingClient.on("close", () => {
            logger.info(`SSH connection from client ${this.ip} has been closed`);
            this.cleanup();
        });

        this.connectingSession.on("pty", (accept, reject, info) => {
            this.sshPtyInfo = info;
            if (accept) accept();
        });

        // On connection requesting an interactive shell session.
        this.connectingSession.on("shell", (acceptShell, rejectShell) => {
            this.connectingShell = acceptShell();
            this._handleInteractiveShell();
        });

        // On connection requesting to execute a one-time command.
        this.connectingSession.on("exec", (acceptExec, rejectExec, info) => {
            const stream = acceptExec();
            this._handleSingleExec(stream, info.command);
        });

        // Start the SSH proxy (if it wasn't started already).
        const proxyResult = await this.ensureSSHConnection();
        if (!proxyResult) {
            logger.error(`Could not establish an SSH connection to the proxy for IP ${this.ip}!`);
            return;
        }
    }
};