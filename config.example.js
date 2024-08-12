const os = require("os");

module.exports = {
    ssh: {
        // Defines the start and end port ranges for the VM SSH port forwarding, unless you have a good reason don't touch this.
        port_forward_range: {
            start: 35000,
            range: 5000
        },

        // Defines the keypair that the SSH server will broadcast to connecting clients.
        // You can use the default keys, but you should generate your own.
        // As a reminder, the default keys in this repository are now public and should not be used for any security or cryptographic purposes.
        private_key_path: "./keys/private-key.pem",

        // The interface details the SSH server will listen on.
        // If you would like to make it to anyone can connect on port 22, set host to "0.0.0.1" and port to 22.
        host: "127.0.0.1",
        port: 3000
    },

    vm: {
        // The number of VM instances that can be active at any time, with connections surpassing this being rejected.
        max_instances: 1,

        // The amount of CPUs to spawn the virtual machine with.
        cpus: 2,

        // The amount of memory to spawn the virtual machine with.
        memory: "256M",

        // Whether to enable the VM to access the internet.
        // Enabling this setting is not recommended and is risky, I've only included this setting for users that know what they're doing.
        allowNetworking: false,

        monitor: {
            // The total CPU use percentage at which the VM monitor will consider killing the VM for excess CPU usage.
            high_cpu_threshold: 40,

            // The amount of "strikes" until a warning is displayed regarding high CPU use of the VM.
            // A strike happens for every instance the VMs CPU use is >= high_cpu_threshold, every 500 milliseconds.
            // A strike is deducted once the VM CPU usage is under the high_cpu_threshold.
            high_cpu_warning_strikes: 15000 / 500,

            // The amount of "strikes" until the VM is killed for high CPU utilization, dropping the shell connection as well.
            high_cpu_kill_strikes: 25000 / 500
        }
    },

    logging: {
        // The maximum size of the output stdout that will be logged when executing an "exec".
        // Subsequent stdout bytes will be ignored from logs after this limit is reached.
        // This is a rough limit, and it's likely some data will overflow as the limit is enforced per chunks of data.
        exec_max_stdout_entry: 1048576,

        ssh_session_replay: {
            // The maximum size, in bytes, of an individual SSH session replay log file.
            // Subsequent stdout bytes will be ignored from logs after this limit is reached.
            // This is a rough limit, and it's likely some data will overflow as the limit is enforced per chunks of data.
            max_replay_size: 10485760,

            // Whether to terminate the VM after the max_replay_size is reached.
            // If your only purpose is to log the entire SSH session, you should enable this to avoid wasting resources on logs that will be truncated anyways.
            terminate_vm_on_max_replay_size: false
        }
    },

    // The directory to use for temporary files, change this if not on a Unix system! (e.g. C:\Users\<username>\AppData\Local\Temp on Windows).
    // Make sure there is no ending /.
    temp_directory: os.tmpdir(),

    // The directory in which logs of SSH interactions are stored.
    data_directory: "./data"
};