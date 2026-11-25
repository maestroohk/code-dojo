# Packages and services

> The new server `jaffa` sits in the bakery basement, next to the ovens, with **no internet connection** ("security", says Brenda; "the Wi-Fi doesn't reach", says everyone else). Ops left two package files on it: the *Crumb Of The Day* server `crumbd` and its command-line client `sprinkles-cli`. Get the service installed, configured, running, reachable and surviving reboots.

## Packages on Debian and Ubuntu

A **package** (`.deb`) is an archive of files plus a label: name, version, dependencies, and scripts to run on install. Two layers of tools:

| | dpkg (low level) | apt (high level) |
|---|---|---|
| installs | a `.deb` file you give it | from repositories, **with** dependencies |
| fetches dependencies | never | yes (from a repo, or from local files you list) |

```
dpkg -l                      # every installed package (ii = installed OK)
dpkg -l 'open*'              # matching a pattern
dpkg -s jq                   # status and details of one package
dpkg -L jq                   # files a package installed
dpkg -S /usr/bin/jq          # which package owns a file
dpkg-deb -I file.deb         # read a .deb's label without installing
dpkg-deb -c file.deb         # list the files inside a .deb
dpkg -i file.deb             # install a file
dpkg -r name                 # remove (keep config)    dpkg -P name    purge (config too)
apt install ./file.deb       # install a local file and resolve its dependencies
apt install jq               # from the repositories (needs network)
```

The Red Hat family has the same split: `rpm` (low level) and `dnf` (high level). Module 8 of the track compares them.

## Services

A **service** (daemon) is a program that runs in the background, usually started at boot. Modern distros manage them with systemd; this container uses classic **SysV init scripts** in `/etc/init.d/`. The ideas map one to one:

| task | SysV init (here) | systemd |
|---|---|---|
| start / stop / restart | `service crumbd start` | `systemctl start crumbd` |
| is it running? | `service crumbd status` | `systemctl status crumbd` |
| start at boot | `update-rc.d crumbd defaults` | `systemctl enable crumbd` |
| logs | the service's log file | `journalctl -u crumbd` |

## Is it listening?

```
ss -ltn                      # listening TCP sockets (-l listening, -t TCP, -n numeric)
ss -ltnp                     # ...and which process owns each one
ss -ltn 'sport = :8080'      # just one port
nc -v 127.0.0.1 8080         # connect and see what it says
```

The local address tells you who can connect: `127.0.0.1:8080` only this machine; `0.0.0.0:8080` (or `*:8080`) any address the machine has.

> **The service loop:** change config, restart, check it's listening, test it from a client, read the log if anything is off. You will do this a thousand times; it never stops being satisfying when it works.

This mission practises modules 4 and 8 of the *Linux & the shell* track (services, packages and querying them).
