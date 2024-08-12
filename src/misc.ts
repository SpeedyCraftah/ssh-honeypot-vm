import { exec, type ChildProcess } from "child_process";

export function checkCMDAvailable(binary: string) {
    return new Promise((resolve, reject) => {
        const cmd = exec(`bash -c "${binary} --version >/dev/null 2>&1 || exit 1"`);
        cmd.once("exit", (code) => {
            if (code === 1) reject(null);
            else resolve(true);
        });
    });
}

export function checkCMDFailure(cmd: ChildProcess): Promise<boolean> {
    return new Promise((resolve) => {
        cmd.once("exit", (code) => {
            if (code === 1) resolve(false);
            else resolve(true);
        });
    });
}

export function execReadStdio(cmd: ChildProcess): Promise<string> {
    return new Promise((resolve, reject) => {
        let output = "";

        cmd.stdout?.on("data", (data) => {
            output += data;
        });

        cmd.once("exit", code => {
            if (code === 1) reject();
            else resolve(output);
        });

        cmd.once("error", (err) => {
            reject(err);
        });
    });
}