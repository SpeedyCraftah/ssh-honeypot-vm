# ssh-honeypot-vm
An SSH honeypot for port scanners which emulates a fake SSH port, executes all commands in a virtual Ubuntu machine, and logs them in a file. I always see port scanners attempting to connect to my servers via SSH, and wanted to see what they would actually do if they were to successfully connect, preferably not at the expense of my server or data 🙂.

This project was inspired by [this video](https://www.youtube.com/watch?v=tyKyLhcKgNo) on YouTube where Grant builds a simple SSH honeypot which logs all commands executed, but I wanted to expand on that and make it appear like an actual machine behind the SSH connection by using a pool of Qemu virtual machines and executing the commands inside on them.

Work in progress! 🚧🚧👷

## How it works
- A pool of virtual machines (amount being configurable) is spawned using Qemu, or spawned on demand, with a configurable amount of resources, each having their own virtual disk configured with a minimal pre-installed Ubuntu 22.04 snapshot, or another image of your choosing.
- An SSH server is setup on the virtual machine, and port forwarded to the host to an arbitrary local port, where the honeypot will connect to and act as an intermediary between the VM and connecting client.<details><summary>*Why?*</summary>You might ask, why not just port forward and expose the virtual machine directly to the public? An intermediary server is in place so that the actual commands can be logged and allows for a lot more flexibility; for example by rejecting connections if the VM pool is already filled with other connections, or by spawning new VM instances on the fly if required.</details>
- The intermediary server will spawn or use an existing VM to forward the SSH commands to. If no VM instance is free, the connection will simply be rejected with an "incorrect password" error.
- The user that the client will connect to on the virtual machine can be configured to be an unprivileged user, or the root user, with root being the default. Changing the default to an unprivileged user would allow for privilege escalation attack attempts to be seen.
- Commands executed by the client are logged in a directory separated by their IP, with different sessions being logged in different files, even logging a complete replay of the command sequences and responses of the entire SSH session.

## Security concerns considered
- Network access is disabled by default and only uses a private network specifically isolated to the machine with port forwarding enabled for SSH to prevent the honeypots from being used for nefarious purposes such as botnets, DDoS attacks or spam mail. You can enable networking for the internet at your own risk with some bandwidth throttling options as well, but do take into account that any actions the client does involving the network is your responsibility when it comes to hosting providers or ISPs, which can lead to bans or other actions being taken against you.
- The honeypots can be configured to last a set amount of time per connection before it preempts and kicks the connected client off, acting as if the SSH connection randomly dropped, allowing for other clients to connect to the honeypot. They can also be configured to last as long as possible to allow for long-lived forms of attack to be considered.
- The VMs CPU usage is monitored, and VMs using too much CPU for an extended period of time will automatically be killed and preempted to prevent the system from locking up from clients running computationally heavy operations. The `niceness` value for Qemu processes are also made low on purpose to eliminate the risk of the system locking up from multiple VMs running at 100% CPU utilization.
- Although all care has been taken to ensure this is secure, I would personally not recommend using this on a production or serious VPS/server incase anything happens, especially since this has not been thoroughly tested. I would recommend using a virtual machine connected to the internet or by renting a VPS per hour from a provider like Azure and running it there. While Qemu is an amazing piece of software with extremely little risk of software escaping virtualisation, mistakes can happen.
- Run the software under an unprivileged user with port 22 allowed, and definitely do not enable any hardware/nested virtualisation or hardware passthrough, this should be enough to prevent any accidents.

## Linux image
You can either use my `qcow2` image and use it as is, modify it, or create your own to personalise the VM that is used for SSH connections.

### Custom image configurations
The following are instructions and recommendations on creating and configuring a custom and compatible image.

*To avoid any doubt, PLEASE DO NOT ACCIDENTALLY CONFIGURE THESE ON YOUR MAIN SERVER AS THEY PURPOSEFULLY DEGRADE SECURITY! THESE ARE MEANT TO BE APPLIED TO YOUR VIRTUAL MACHINE INSTANCE ONLY.*


#### Requirements for an image
These are the only requirements for an image to be suitable as a honeypot:
- sshd server must be installed and listening on port 22.
  - `PermitRootLogin=yes` must be present in the `/etc/ssh/sshd_config` file.
- Set your root password to `root123` (or to your configured value if applicable) by running `sudo -i` and `passwd` while logged in as root.
- Finally, and after any configurations or changes you make to the image, boot the VM and wait for it to enter the login screen and create a snapshot of it under the name `snapshot` in Qemu by running `savevm snapshot` in the monitor. This is so VM instances can be rapidly started instead of waiting for the entire Linux kernel to boot each time which can take a while.

#### Recommendations for custom image
Not required, but some tweaks you can make which improve the VM:
- Disable CPU mitigations for vulnerabilities as they are not needed in this case, and can improve performance of the VM and allow clients to potentially exploit these if the VM's emulated CPUs are vulnerable to them:
  - Edit `/etc/default/grub` and add `mitigations=off` to the end of `GRUB_CMDLINE_LINUX`, then run `update-grub` for Ubuntu, or `grub2-mkconfig` for other distributions.
- For quicker SSH sign-ins on the VM end, disable the DNS lookup on connections which can take a while by going into `/etc/ssh/sshd_config` and adding `UseDNS no`.
- To maximise the amount of VMs you can spawn and reduce the memory requirements, be smart with the distribution you choose and software you install on the image. For reference, I managed to get an Ubuntu instance running sshd to use only `71MiB` of memory (excluding caches) with little extra configuration. Do note Qemu also takes up a bit of memory, on a VM with `256MiB` of RAM and 2 cores, Qemu used an additional 62MiB, in total (256MiB + 62MiB) = 318MiB, I'd imagine this overhead will grow should you decide to add more cores. <details><summary>*Why is the 256MiB of memory fully in use in the calculation?*</summary>VM hypervisors don't know how much of the memory the system running inside is actually using or needs, so it has to allocate the maximum memory provided to Qemu. You could reduce this by using `ballooning` and installing a `ballooning` driver on the VM, which will tell the VM which parts of the memory the system running is and isn't using which lets it use only as much as it needs, but this seems to be quite an undocumented area, as most things in Qemu are.</details>

## Potential future plans
- IP clients could get their own personalised VM instance by saving the VM state of that specific IP connection to the directory location, which means any changes or things they've done to the VM will persist across different connections and sessions.
