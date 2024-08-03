# ssh-honeypot-vm
An SSH honeypot for port scanners which emulates a fake SSH port, executes all commands in a virtual Ubuntu machine, and logs them in a file. I always see port scanners attempting to connect to my servers via SSH, and wanted to see what they would actually do if they were to successfully connect.

This project was inspired by [this video](https://www.youtube.com/watch?v=tyKyLhcKgNo) on YouTube where Grant builds a simple SSH honeypot which logs all commands executed, but I wanted to expand on that and make it appear like an actual machine behind the SSH connection by using a pool of Qemu virtual machines and executing the commands inside on them.

Work in progress! 🚧🚧👷

## How it works
- A pool of virtual machines (amount being configurable) is spawned using Qemu with a configurable amount of resources, each having their own virtual disk configured with a minimal pre-installed Ubuntu 22.04 snapshot, or another image of your choosing. The machines have an exposed telnet connection via a FIFO pipe so that commands can be fed in and out of the machine.
- An SSH server is setup on the virtual machine, and port forwarded to the host to an arbitrary local port, where the honeypot will connect to and act as an intermediary between the VM and connecting client.<details><summary>*Why?*</summary>You might ask, why not just port forward and expose the virtual machine directly to the public? An intermediary server is in place so that the actual commands can be logged and allows for a lot more flexibility; for example by rejecting connections if the VM pool is already filled with other connections, or by spawning new VM instances on the fly if required.</details>
- The intermediary server will spawn or use an existing VM to forward the SSH commands to. If no VM instance is free, the connection will simply be rejected with an "incorrect password" error.
- The user that the client will connect to on the virtual machine can be configured to be an unprivileged user, or the root user, with root being the default. Changing the default to an unprivileged user would allow for privilege escalation attack attempts to be seen.
- Commands executed by the client are logged in a directory separated by their IP, with different sessions being a different directory.

## Security concerns considered
- Network access is disabled by default and only uses a private network specifically isolated to the machine with port forwarding enabled for SSH to prevent the honeypots from being used for nefarious purposes such as botnets, DDoS attacks or spam mail. You can enable networking for the internet at your own risk with some bandwidth throttling options as well, but do take into account that any actions the client does involving the network is your responsibility when it comes to hosting providers or ISPs, which can lead to bans or other actions being taken against you.
- The honeypots can be configured to last a set amount of time per connection before it preempts and kicks the connected client off, acting as if the SSH connection randomly dropped, allowing for other clients to connect to the honeypot. They can also be configured to last as long as possible to allow for long-lived forms of attack to be considered.
- The VMs CPU usage is monitored, and VMs using too much CPU for an extended period of time will automatically be killed and preempted to prevent the system from locking up from clients running computationally heavy operations.
- Although all care has been taken to ensure this is secure, I would personally not recommend using this on a production or serious VPS/server incase anything happens, especially since this has not been thoroughly tested. I would recommend using a virtual machine connected to the internet or by renting a VPS per hour from a provider like Azure and running it there.

## Potential future plans
- IP clients could get their own personalised VM instance by saving the VM state of that specific IP connection to the directory location, which means any changes or things they've done to the VM will persist across different connections and sessions.
