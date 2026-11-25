# Mission 20: a server with a broken user, a sneaky user and an SSH daemon.
set -e
rm -f /etc/ssh/ssh_host_*
ssh-keygen -A >/dev/null
sed -i -E 's/^#?PasswordAuthentication .*/PasswordAuthentication yes/' /etc/ssh/sshd_config
grep -q '^PasswordAuthentication' /etc/ssh/sshd_config || echo 'PasswordAuthentication yes' >> /etc/ssh/sshd_config

# marvin: key login used to work, until someone "fixed the permissions".
useradd -m -s /bin/bash -c "Marvin, head baker" marvin
mkdir -p /home/marvin/.ssh
rm -f /keydrop/marvin /keydrop/marvin.pub
ssh-keygen -q -t ed25519 -N '' -C marvin@laptop -f /tmp/marvin
cp /tmp/marvin.pub /home/marvin/.ssh/authorized_keys
cp /tmp/marvin.pub /keydrop/marvin.pub
cp /tmp/marvin /keydrop/marvin.part && mv /keydrop/marvin.part /keydrop/marvin
rm -f /tmp/marvin /tmp/marvin.pub
chown -R marvin:marvin /home/marvin
chmod 777 /home/marvin/.ssh
chmod 666 /home/marvin/.ssh/authorized_keys
chmod 775 /home/marvin

# An account nobody remembers creating.
useradd -m -s /bin/bash -u 1337 -c "temp account" "$DOJO_SNEAKY"
echo "$DOJO_SNEAKY:$(head -c 12 /dev/urandom | base64)" | chpasswd
mkdir -p "/home/$DOJO_SNEAKY/.ssh"
ssh-keygen -q -t ed25519 -N '' -C "who@knows" -f /tmp/sneaky
cp /tmp/sneaky.pub "/home/$DOJO_SNEAKY/.ssh/authorized_keys"
rm -f /tmp/sneaky /tmp/sneaky.pub
chown -R "$DOJO_SNEAKY:$DOJO_SNEAKY" "/home/$DOJO_SNEAKY"
chmod 700 "/home/$DOJO_SNEAKY/.ssh"

/usr/sbin/sshd
