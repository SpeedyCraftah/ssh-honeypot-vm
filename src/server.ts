import { Server } from "ssh2";
import fs from "fs";
import Client from "./client";
import { config, logger } from ".";
import { images } from "./images";
import VMInstance, { vmInstances } from "./vm-instance";

export default new Server({
    hostKeys: [fs.readFileSync(config.ssh.private_key_path, { encoding: "utf8" })]
}, (client, info) => {
    logger.info(`Connection established to SSH server by client ${info.ip}, greeting=${info.header.greeting || "none"}, comments=${info.header.comments || "none"}, client=${info.header.versions.software}`);
    
    const authCloseListener = () => {
        logger.debug(`Connection with client ${info.ip} has closed before managing to authenticate`);
    };

    client.on("close", authCloseListener);
    client.on('authentication', (ctx) => {
        setTimeout(() => {
            if (ctx.method === "password") {
                // Reject the connection with incorrect password if there isn't any VMs we can use.
                if (vmInstances.length >= config.vm.max_instances) {
                    setTimeout(() => ctx.reject(["password"]), 1000);
                    logger.info(`Client ${info.ip} tried to authenticate with password "${ctx.password}", but there was no available VM instance to spawn, so it was rejected`);
                    return;
                }

                logger.info(`Client ${info.ip} authenticated with password "${ctx.password}", allowing session..`);
                ctx.accept();
            } else logger.info(`Client ${info.ip} tried to authenticate with method "${ctx.method}", but only passwords are allowed, so it was rejected`);
            
            ctx.reject(["password"]);
        }, 1000);
    });

    client.on("ready", () => {
        client.removeListener("close", authCloseListener);
        client.on("session", async (accept, reject) => {
            const session = accept();

            logger.info("Creating VM instance for new client..");

            const image = images.get("ubuntu");
            if (!image) return;

            const vm = new VMInstance(image);
            vmInstances.push(vm);

            new Client(client, info.ip, session, vm);
        });
    });
});