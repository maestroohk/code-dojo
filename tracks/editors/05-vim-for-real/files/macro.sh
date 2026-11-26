# Lesson 3: host names to turn into a YAML list with a macro.
. "$DOJO_FILES/lib.sh"
printf '%s\n' web1.example.com web2.example.com web3.example.com api1.example.com > ~/hosts.txt
printf '%s\n' '- "web1.example.com"' '- "web2.example.com"' '- "web3.example.com"' '- "api1.example.com"' > /opt/dojo/state/hosts.expected
chmod 644 /opt/dojo/state/hosts.expected
