# The permission heist

> Friday, 17:02. The deploy bot tried to ship the new biscuit shop and got a face full of **Permission denied**. Gary's last words before leaving for the llama farm: *"I'll just chmod 777 everything."*
>
> Your job: make the deploy work **without** handing the keys to everyone. Read the evidence in `/srv/app/deploy.log`.

## Who may do what

Every file has an **owner** (a user), a **group**, and three sets of permissions:

```
-rwxr-x---  1 root deployers  220 Nov 24 17:00 deploy.sh
 │└┬┘└┬┘└┬┘    │    │
 │ │  │  │     │    └ group
 │ │  │  │     └ owner
 │ │  │  └ others: ---  nothing
 │ │  └ group:  r-x  read + execute
 │ └ owner:     rwx  read + write + execute
 └ type: - file, d directory, l link
```

| | on a file | on a directory |
|---|---|---|
| **r** (4) | read it | list the names in it |
| **w** (2) | change it | create, delete, rename files in it |
| **x** (1) | run it | enter it (`cd`) and reach files inside |

Octal is just the sum per set: `rwx` = 7, `r-x` = 5, `rw-` = 6, `r--` = 4, `---` = 0. So `-rwxr-x---` is **750**.

## The tools

```
ls -l file                  ls -ld dir        # look (-d: the directory itself)
stat -c '%a %U:%G' file                       # octal mode, owner and group
chmod 640 file              chmod u+x,o-r file        # set / adjust permissions
chown alice:devs file       chgrp devs file           # change owner/group (root only)
id alice                                      # a user's groups
usermod -aG devs alice                        # add alice to devs (-a: keep the others!)
su - alice -c 'command'                       # run a command as alice (from root)
```

## sudo

`sudo` lets a user run a command as root, if a rule allows it. Rules live in `/etc/sudoers` and `/etc/sudoers.d/*`:

```
alice  ALL=(ALL)  ALL                                  # alice may do anything (as an admin)
bob    ALL=(root) NOPASSWD: /usr/local/bin/backup      # bob may run exactly one command
```

Always check with `visudo -c`: a syntax error in sudoers can lock everyone out of sudo.

## umask: default permissions

New files don't start at 777: the **umask** takes bits away. With the usual `umask 022`, new files are `644` and new folders `755`. A private-by-default `umask 027` gives `640` and `750`. Try `umask`, then `touch x; ls -l x`.

> **Why 777 is never the answer:** it makes the file writable by every user and every compromised service on the machine. The fix is always: *which* user needs *which* access, then grant exactly that, usually through a group.

This mission practises module 3 of the *Linux & the shell* track (permissions, owners, sudo and umask).
