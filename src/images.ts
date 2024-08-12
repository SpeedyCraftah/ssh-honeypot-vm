import { config, logger } from "./index";
import fs from "fs/promises";
import path from "path";
import { exec } from "child_process";
import { checkCMDFailure } from "./misc";

export interface ImageDescriptor {
    name: string;
    path: string;
    snapshotPresent: boolean;
};

export const images: Map<string, ImageDescriptor> = new Map();
export async function discoverImages() {
    logger.debug("Discovering images listed in the image directory..");
    
    const imageDirectories = await fs.readdir("./images", { withFileTypes: true });
    for (const imageDirectory of imageDirectories) {
        if (!imageDirectory.isDirectory()) {
            logger.warn(`Discovered a file with name '${imageDirectory.name}' which is not a directory, it will be ignored`)
            continue;
        }
        
        // Check if the disk image exists.
        const diskImagePath = path.join(config.cwd, "images", imageDirectory.name, "disk.qcow2");
        const diskImage = await fs.stat(diskImagePath).catch(() => null);
        if (!diskImage) {
            logger.warn(`Discovered image '${imageDirectory.name}', but it has no 'disk.qcow2' file, it will be ignored`);
            continue;
        }
        
        // Check if the image is valid.
        const healthCheck = await checkCMDFailure(exec(`qemu-img check ${diskImagePath}`));
        if (!healthCheck) {
            logger.warn(`Discovered image '${imageDirectory.name}', but it doesn't appear to be a valid qcow2 image, it will be ignored`);
            continue;
        }

        // Check if the image is a backing file.
        const backingCheck = await checkCMDFailure(exec(`qemu-img info ${diskImagePath} | grep "backing file:"`));
        if (!backingCheck) {
            logger.warn(`Discovered image '${imageDirectory.name}', but it is not a backing file, this is not required but performance & storage use will likely be poor as the entire image has to be copied for each new VM instance`);
            logger.info("Rename your base image, create a backing file from the base image using 'qemu-img create -b' called 'disk.qcow2'");
        }

        // Check if the image has a snapshot.
        // Check if snapshot called "snapshot" exists.
        const snapshotCheck = await checkCMDFailure(exec(`qemu-img snapshot ${diskImagePath} -l | grep " snapshot "`));
        if (!snapshotCheck) {
            logger.warn(`Discovered image '${imageDirectory.name}', but it has no snapshot named 'snapshot', this is not required but VM time-to-start will be poor due to the machine having to boot fully each time`);
            logger.info("Boot into your VM and create a snapshot called 'snapshot' using 'savevm snapshot' after boot");
            continue;
        }

        images.set(imageDirectory.name, { name: imageDirectory.name, path: diskImagePath, snapshotPresent: snapshotCheck });
        logger.info(`Discovered image '${imageDirectory.name}' (${(diskImage.size / 1024 / 1024).toFixed(0)} MiB)`);
    }

    logger.debug(`Finished discovering, discovered ${images.size} ${images.size === 1 ? "image" : "images"}`);
    if (!images.size) {
        logger.fatal("No suitable images have been found for use, ensure you have at least one image in the images directory!");
        process.exit(1);
    }
}