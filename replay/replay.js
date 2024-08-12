const fs = require("fs");

const replayFilePath = process.argv[2];
if (!replayFilePath) {
    console.error("Enter the path of the SSH session log to replay.");
    process.exit(1);
}

let replayFile;
try {
    replayFile = fs.readFileSync(replayFilePath);
} catch(err) {
    console.error("Could not open the replay file!", err);
    process.exit(1);
}

const INTERRUPT_KEYCODE = new Uint8Array([0x3]);
const SPACE_KEYCODE = new Uint8Array([' '.charCodeAt(0)]);
const R_KEYCODE = new Uint8Array([0x72]);

function initTerminal() {
    process.stdout.write("\x1Bc");
    process.stdout.write("Reading back the shell session - use the space bar to go forward, R key to reset, CTRL+C to exit.\n\n");
}

// Prepare the terminal.
initTerminal();
process.stdin.setRawMode(true);

let bufferIndex = 0;
process.stdin.on("data", async inputData => {
    // Exit on CTRL+C.
    if (inputData.compare(INTERRUPT_KEYCODE) === 0) {
        process.stdout.write("\x1b[!p");
        process.exit(0);
    }

    // Forward the replay.
    else if (inputData.compare(SPACE_KEYCODE) === 0) {
        // Clear the terminal on first character.
        if (bufferIndex === 0) process.stdout.write("\x1Bc");

        while (bufferIndex < replayFile.byteLength) {
            let currentByte = replayFile.readUint8(bufferIndex++);
            if (currentByte === 0) break;

            // Write the byte to stdout.
            process.stdout.write(new Uint8Array([currentByte]));
        }
    }

    else if (inputData.compare(R_KEYCODE) === 0) {
        bufferIndex = 0;
        initTerminal();
    }
});