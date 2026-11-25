# Mission 20: your laptop. Picks up marvin's private key once wafer has made it.
mkdir -p /root/.ssh && chmod 700 /root/.ssh
cat > /root/.ssh/config <<'CFG'
Host wafer
    HostName 10.40.1.10
CFG
(
  for i in $(seq 1 60); do
    if [ -s /keydrop/marvin ]; then
      cp /keydrop/marvin /root/.ssh/marvin_key && chmod 600 /root/.ssh/marvin_key
      cp /keydrop/marvin.pub /root/.ssh/marvin_key.pub
      break
    fi
    sleep 1
  done
) > /dev/null 2>&1 &
