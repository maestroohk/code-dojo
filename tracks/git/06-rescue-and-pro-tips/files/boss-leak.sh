# Boss: an access key hard-coded two commits ago, not pushed yet.
. "$DOJO_FILES/lib.sh"
fresh_repo /opt/dojo/seed
write config.json '{' '  "region": "eu-west-1",' '  "bucket": "shop-assets"' '}'
commit "Start the shop"
publish shop
cd ~ && rm -rf ~/shop && git clone -q /srv/git/shop.git ~/shop && cd ~/shop
write config.json '{' '  "region": "eu-west-1",' '  "bucket": "shop-assets",' '  "accessKeyId": "AKIAEXAMPLE7Q2LMN4ZP"' '}'
write src/Upload.cs "class Upload {}"
commit "Upload product images to the bucket"
write src/Upload.cs "class Upload { int Retries = 3; }"
commit "Retry failed uploads"