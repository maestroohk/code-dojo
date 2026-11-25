# Users and SSH

> Big day: Byte & Biscuit hired its first new baker in two years. They need an account on the recipe server `wafer`, a shared folder with the other bakers, and SSH access from the office laptop. Meanwhile, Marvin the head baker has been locked out since Gary "tidied up", and a security scan found an account on `wafer` that nobody can explain.

Two machines this time: **laptop** (where you sit) and **wafer** (the server). Open a terminal on each; the tab names tell you where you are.

## Users and groups

```
/etc/passwd     one line per account:  name:x:UID:GID:comment:home:shell
/etc/group      one line per group:    name:x:GID:members
/etc/shadow     password hashes (root only)
```

```
groupadd bakers                          # new group
useradd -m -s /bin/bash -G bakers ana    # new user: home dir, shell, extra group
passwd ana                               # set a password (or: echo 'ana:pw' | chpasswd)
usermod -aG bakers ana                   # add to a group later (-a keeps the others)
usermod -s /usr/sbin/nologin ana         # change the login shell
usermod -L ana   /  usermod -U ana       # lock / unlock the password
id ana     getent passwd ana     passwd -S ana     # inspect
userdel -r ana                           # delete user and home (careful)
```

A shell of `/usr/sbin/nologin` or `/bin/false` means "this account exists, but no one logs in as it": normal for service accounts like `www-data`.

## Shared folders: the setgid bit

A file normally belongs to its creator's own group, so in a shared folder everyone ends up with files the others can't edit. Set the **setgid** bit on the directory and new files inherit **the directory's** group:

```
mkdir /srv/team && chgrp devs /srv/team && chmod 2770 /srv/team
ls -ld /srv/team      # drwxrws---  (the s is setgid)
```

## SSH with keys

```
ssh-keygen -t ed25519          # make a key pair: ~/.ssh/id_ed25519 (private!) and .pub (public)
ssh-copy-id ana@wafer          # put your public key in ana's ~/.ssh/authorized_keys on wafer
ssh ana@wafer                  # log in
ssh -i ~/.ssh/other_key ana@wafer   # use a specific key
ssh -v ana@wafer               # verbose: shows which keys are tried and why login fails
```

The server only trusts `authorized_keys` if nobody else could have changed it (sshd's **StrictModes**). The safe permissions:

| path | mode | owner |
|---|---|---|
| `/home/ana` | `755` or `750` (no group/other write) | ana |
| `/home/ana/.ssh` | `700` | ana |
| `/home/ana/.ssh/authorized_keys` | `600` | ana |

`namei -l /home/ana/.ssh/authorized_keys` shows the permissions of every step of a path at once.

> **Locking accounts:** `usermod -L` only disables the *password*. SSH keys still work! To really stop logins, also set the shell to `nologin`, or remove the keys (or, on a real server, `usermod --expiredate 1`).

This mission practises modules 3 and 6 of the *Linux & the shell* track (users and permissions, SSH).
