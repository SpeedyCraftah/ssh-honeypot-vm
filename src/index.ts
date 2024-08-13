import Pino from "pino";
import { discoverImages, images } from "./images";
import { vmInstances } from "./vm-instance";
import fs from "fs/promises";
import SSHServer from "./server";
import { checkCMDAvailable } from "./misc";
import { tmpdir } from "os";
import exitHook from "async-exit-hook";

// Setup the logger for information and debugging.
export const logger = Pino({
    transport: { target: "pino-pretty" },
    level: "debug"
});

// Type definition for the config.
interface Config {
    ssh: {
        port_forward_range: {
            start: number;
            range: number;
        },

        private_key_path: string;
        host: string;
        port: number;
    },

    vm: {
        image_name: string;
        max_instances: number;
        cpus: number;
        memory: string;
        allowNetworking: boolean;
        
        monitor: {
            high_cpu_threshold: number;
            high_cpu_warning_strikes: number;
            high_cpu_kill_strikes: number;
        }
    },

    logging: {
        exec_max_stdout_entry: number;

        ssh_session_replay: {
            max_replay_size: number;
            terminate_vm_on_max_replay_size: boolean;
        }
    },

    temp_directory: string;
    data_directory: string;
    cwd: string;
};

export let config: Config;

(async() => {
    if (!(await fs.stat("./config.js").catch(() => null))) {
        logger.fatal("Config file could not be found, make sure it is in the current working directory!");
        process.exit(1);
    }

    // Check if important utilities are present.
    logger.debug("Checking for shell utilities..");
    if (!(await checkCMDAvailable("qemu-system-x86_64").catch(() => null))) {
        logger.fatal("Required utility qemu-system-x86_64 not found, make sure it is installed!");
        process.exit(1);
    }

    if (!(await checkCMDAvailable("qemu-img").catch(() => null))) {
        logger.fatal("Required utility qemu-img not found, make sure it is installed!");
        process.exit(1);
    }

    // Read the config.
    config = require("../config.js");
    if (!config.temp_directory) config.temp_directory = tmpdir();
    if (!config.cwd) config.cwd = process.cwd();

    // Unix-specific check.
    logger.debug("Checking for temp directory..");
    if (!(await fs.stat(config.temp_directory).catch(() => null))) {
        logger.fatal("Temp directory could not be found");
        process.exit(1);
    }

    // Create the temporary directory for VM instances.
    await fs.mkdir(`${config.temp_directory}/ssh-honeypot-vm`).catch((error) => {
        if (error.code !== "EEXIST") {
            logger.fatal(`Could not create the temp directory! ${error.code} on ${error.path}`);
            process.exit(1);
        }
    });

    // Create the data directory.
    await fs.mkdir(config.data_directory).catch((error) => {
        if (error.code !== "EEXIST") {
            logger.fatal(`Could not create the data directory! ${error.code} on ${error.path}`);
            process.exit(1);
        }
    });

    await discoverImages();

    // Check if image set in config exists.
    if (!images.has(config.vm.image_name)) {
        logger.fatal(`Could not find the set image under the name "${config.vm.image_name}"! Is it present in the images directory?`);
        process.exit(1);
    }

    SSHServer.once("listening", () => {
        logger.info(`SSH server is listening on port ${config.ssh.port} on interface ${config.ssh.host}`);
    });
    
    SSHServer.listen(config.ssh.port, config.ssh.host);
})();

// Program end cleanup.
exitHook(async (done) => {
    logger.debug("Stopping virtual machines..");
    for (const vm of vmInstances) {
        vm.destroy();
    }

    logger.debug("Cleaning up shadow VM images and temporary files..");
    await fs.rm(`${config.temp_directory}/ssh-honeypot-vm`, { force: true, recursive: true });
    done();
});