# Boss, last step: a staged change that needs a commit message a reviewer can use.
. "$DOJO_FILES/lib.sh"
fresh_repo ~/shop
write src/Payments.cs "class Payments" "{" "    public void Charge() => gateway.Send(request);" "}"
commit "Start payments"
write src/Payments.cs "class Payments" "{" "    // The gateway times out under load; retry twice with backoff before failing the order." \
  "    public void Charge() => Retry.Twice(() => gateway.Send(request), backoffMs: 200);" "}"
git add src/Payments.cs
