# Mission 18: some sample data to try your scripts on.
mkdir -p /srv/batches /srv/recipes
printf 'flour\nbutter\n' > /srv/batches/choc.batch
printf 'oats\n' > "/srv/batches/oat raisin.batch"
printf 'flour\nsugar\nvanilla\n' > /srv/batches/vanilla.batch
echo "not a batch" > /srv/batches/notes.txt
echo "2 spoons of jam" > /srv/recipes/jam.txt
printf 'choc 3\noat 4\ncustard 10\n' > /root/orders.txt
