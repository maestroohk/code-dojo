#!/bin/bash
# Makes the real AWS plans of module 6 (plans/aws-pr.json, plans/aws-pr-fixed.json and 06-plan-review/files/aws-pr.json)
# without an AWS account: plan the base config from nothing (-refresh=false, so no API calls), turn its planned values
# into a state file (filling in the IDs AWS would assign), then plan the pull request (after/) and its fixed version
# (fixed/) against that state with the real hashicorp/aws provider. Needs a network (it downloads the provider):
#
#   docker run --rm -v "<repo>/tracks/terraform:/t" dojo-terraform:latest bash /t/plans/aws-pr/make.sh
set -e -o pipefail
export TF_CLI_CONFIG_FILE=/work/net.rc
rm -rf /work && mkdir -p /work/cache && cp -r /t/06-plan-review/files/aws-pr/. /work/
printf 'disable_checkpoint = true\nplugin_cache_dir = "/work/cache"\n' > /work/net.rc
cd /work/before
terraform init -input=false -no-color >/dev/null
terraform plan -refresh=false -input=false -no-color -out=base.tfplan >/dev/null
terraform show -json base.tfplan > base.json
terraform providers schema -json > /work/schema.json
jq --slurpfile schema /work/schema.json '
  # the IDs and computed values AWS would have assigned
  def fill($t):
    if $t == "aws_security_group" then . + {id: "sg-0d4c3b2a19f8e7d61", arn: "arn:aws:ec2:eu-west-1:111122223333:security-group/sg-0d4c3b2a19f8e7d61", owner_id: "111122223333", ingress: [], egress: []}
    elif $t == "aws_vpc_security_group_ingress_rule" then . + {id: "sgr-0aa11bb22cc33dd44", arn: "arn:aws:ec2:eu-west-1:111122223333:security-group-rule/sgr-0aa11bb22cc33dd44", security_group_rule_id: "sgr-0aa11bb22cc33dd44", security_group_id: "sg-0d4c3b2a19f8e7d61"}
    elif $t == "aws_db_instance" then . + {id: "db-ABCDEFGHIJKLMNOPQRSTUVWXY1", resource_id: "db-ABCDEFGHIJKLMNOPQRSTUVWXY1", arn: "arn:aws:rds:eu-west-1:111122223333:db:shop-prod-db", address: "shop-prod-db.c1a2b3c4d5e6.eu-west-1.rds.amazonaws.com", endpoint: "shop-prod-db.c1a2b3c4d5e6.eu-west-1.rds.amazonaws.com:5432", port: 5432, status: "available", vpc_security_group_ids: ["sg-0d4c3b2a19f8e7d61"], db_name: null, master_user_secret: [{kms_key_id: "arn:aws:kms:eu-west-1:111122223333:key/0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b", secret_arn: "arn:aws:secretsmanager:eu-west-1:111122223333:secret:rds!db-1a2b3c4d-AbCdEf", secret_status: "active"}]}
    elif $t == "aws_s3_bucket" then . + {id: "shop-prod-assets-example", arn: "arn:aws:s3:::shop-prod-assets-example", bucket_domain_name: "shop-prod-assets-example.s3.amazonaws.com", bucket_regional_domain_name: "shop-prod-assets-example.s3.eu-west-1.amazonaws.com", hosted_zone_id: "Z1BKCTXD74EZPE", region: "eu-west-1", force_destroy: false}
    elif $t == "aws_s3_bucket_versioning" then . + {id: "shop-prod-assets-example", bucket: "shop-prod-assets-example"}
    elif $t == "aws_instance" then . + {id: "i-0123456789abcdef0", arn: "arn:aws:ec2:eu-west-1:111122223333:instance/i-0123456789abcdef0", private_ip: "10.20.3.17", instance_state: "running", vpc_security_group_ids: ["sg-0fedcba9876543210"]}
    else . end;
  def zero($ty): if $ty == "string" then "" elif $ty == "bool" then false elif $ty == "number" then 0
    elif ($ty | type) == "array" and ($ty[0] == "list" or $ty[0] == "set") then [] elif ($ty | type) == "array" and $ty[0] == "map" then {} else null end;
  # other attributes AWS would have filled in: empty values of the right type, so they are not noise in the diff
  def known($t; $unk):
    ($schema[0].provider_schemas["registry.terraform.io/hashicorp/aws"].resource_schemas[$t].block) as $b
    | reduce (($unk // {}) | to_entries[] | select(.value == true) | .key) as $k (.;
        if .[$k] != null then . elif $b.attributes[$k] then .[$k] = zero($b.attributes[$k].type) elif $b.block_types[$k] then .[$k] = [] else . end);
  . as $b0 | {version: 4, terraform_version: "1.17.2", serial: 41, lineage: "8f6d2c1e-5b4a-4c3d-9e8f-7a6b5c4d3e2f", outputs: {},
   resources: [ .planned_values.root_module.resources[] | . as $r |
     {mode, type, name, provider: "provider[\"registry.terraform.io/hashicorp/aws\"]",
      instances: [ { schema_version: ($schema[0].provider_schemas["registry.terraform.io/hashicorp/aws"].resource_schemas[$r.type].version // 0),
                     attributes: ($r.values | fill($r.type) | known($r.type; ($b0.resource_changes[] | select(.address == $r.address) | .change.after_unknown))),
                     sensitive_attributes: [] } ] } ] }' base.json > /work/prod.tfstate
for v in after fixed; do
  cd /work/$v
  terraform init -input=false -no-color >/dev/null
  cp /work/prod.tfstate terraform.tfstate
  terraform plan -refresh=false -input=false -no-color -out=pr.tfplan > pr.txt
  terraform show -json pr.tfplan | jq -c -f /t/plans/trim.jq > pr.json
  grep -E '^  #|forces|Plan:' pr.txt
done
cp /work/after/pr.json /t/plans/aws-pr.json
cp /work/after/pr.json /t/06-plan-review/files/aws-pr.json
cp /work/fixed/pr.json /t/plans/aws-pr-fixed.json
