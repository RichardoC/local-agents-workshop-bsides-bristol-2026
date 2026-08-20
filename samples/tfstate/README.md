# A Terraform state file full of things that should not be in a Terraform state file

**Everything in `terraform.tfstate` is invented.** Every password, key and token was
made up for this exercise; every hostname uses a reserved TLD (`.example`,
`.invalid`); the personal data is fictional; the "private key" is a base64 string
that says `NOTAREALKEY`. Nothing here authenticates against anything, anywhere.

## Why this file exists

`terraform.tfstate` stores, in plaintext, every value Terraform had to know to
build your infrastructure — including the ones you passed as `sensitive`. Marking a
variable sensitive hides it from the plan output. It does not keep it out of state.

So state files are one of the richest, least-examined places secrets accumulate. And
they are a good place to show what a language model is *actually* useful for,
because the standard tool for this job does badly here.

## The exercise

Run a scanner over it, then run the model over it, and compare.

```bash
# The detector-based scanner
trufflehog filesystem samples/tfstate/terraform.tfstate

# The model
./pi-workshop.sh -p "Use read_design_document on samples/tfstate/terraform.tfstate, then list every credential, secret or piece of personal data you can find. One bullet each: what it is, and where."
```

## What actually happened

Measured, not asserted — trufflehog 3.90.8, default detectors:

```
$ trufflehog filesystem samples/tfstate/terraform.tfstate --json | grep -c DetectorName
2          # two hits, both the same finding
```

**One unique finding**, reported twice — once with `Decoder Type: PLAIN` and once
with `Decoder Type: BASE64`. A `Postgres` detector match on this string:

```
postgresql://orders_admin:Sunflower-Battery-Horse-19@orders-prod.cluster.db.internal.example:5432/orders
```

Now the part worth stopping on. **That same password appears twice in the file.**
Once inside the URI above, and once as a plain field:

```json
"username": "orders_admin",
"password": "Sunflower-Battery-Horse-19",
```

trufflehog found the first and missed the second. It is not recognising the
secret — it is recognising `scheme://user:pass@host`. Take the syntax away and the
identical password becomes invisible to it.

That is the whole lesson of this sample, and it generalises: **detector-based
scanners match shapes.** They are very good at `AKIA…`, `ghp_…`, `xoxb-…`,
`-----BEGIN RSA PRIVATE KEY-----` — strings with a vendor-defined format and often a
live endpoint to verify against. They have nothing to say about a passphrase, a
homegrown key format, a credential in a comment, or a CSV of national insurance
numbers.

**Note what base64 does and does not do here.** That second hit is
`Decoder Type: BASE64`, so trufflehog is decoding base64 and re-scanning the
result — encoding something does not hide it. What keeps the base64 Kubernetes
secrets in this file quiet is not the encoding, it is that
`postmaster@mail.internal.example:Th1sIsTheSmtpP!ss` still matches no detector after
decoding. Do not take away "base64 defeats scanners". Take away "a credential with
no vendor format defeats scanners, encoded or not".

One more thing visible in the output: `Verification issue: lookup
orders-prod.cluster.db.internal.example … no such host`. trufflehog tried to *use*
the credential to confirm it, and the reserved TLD meant there was nothing to reach.
That is the sample being safe by construction, and it is also worth knowing about
the tool — a scanner that verifies is a scanner that makes outbound connections.

A local model reading the same file does considerably better, and it is not because
it is cleverer — it is doing a different job. It reads the file instead of
pattern-matching it.

One run of each, same prompt, both models:

| | trufflehog 3.90.8 | Bonsai 8B Q1_0 | Granite 4.1 3B Q6_K |
|---|---|---|---|
| Distinct findings | **1** | 8 | 16 |
| The plain `password` field | missed | found | found |
| Base64 Kubernetes secrets | missed | missed | found |
| Helm basic-auth passwords | missed | found | found |
| Vendor API key + secret | missed | **found** | missed |
| Personal data export | missed | partly | fully |

Read the last two rows together, because they matter more than the totals. **The two
models found different things.** Granite enumerated every field of the personal data
export and decoded nothing; Bonsai skipped most of the PII but was the only one to
surface the vendor API secret and the note saying it ships in the mobile app bundle.
Neither is a superset of the other, and neither is a superset of the scanner.

So: this is a *complement* to a scanner, not a replacement. The scanner's single
finding was precise, repeatable, and could fail a build on its own. The models'
findings are broader, vary between runs, and need a human to confirm. Both properties
are real, and knowing which tool has which is most of the skill.

## No real-format keys, on purpose

You will not find an `AKIA…` or a `ghp_…` in this file, and their absence is
deliberate twice over. Committing strings shaped like real credentials trips
GitHub's push protection and every scanner in the room, which is noise. And they
are not the interesting case: **the interesting case is the residue a detector
cannot see.** If you want to watch trufflehog succeed, it already did — on the one
connection string.

## Answer key

Try it yourself before opening this.

<details>
<summary>Everything planted in the file, by class</summary>

1. **A low-entropy password in a plain field** — `aws_db_instance.password`.
   No prefix, no fixed length, four English words and a number. Invisible to a
   detector. The same value is in a Postgres URI under
   `null_resource.triggers.command`, which is the one thing trufflehog caught.

2. **A base64 `user_data` blob** — `aws_instance.batch_worker`. Decodes to a
   shell script containing a custom API key, a credential pair written to
   `/etc/app/creds.txt`, and a `curl -u releasebot:…` token. trufflehog decodes it
   and still reports nothing, because none of those three has a format it knows.

3. **Base64 Kubernetes secret data** — `kubernetes_secret.payments_api`. Three
   values: the same custom API key, an SMTP `user:password`, and a session signing
   seed that is an English phrase rather than anything key-shaped.

4. **Credentials inside a YAML string** — `helm_release.values`. Two basic-auth
   passwords (`viewer`, `root`), an OIDC `clientSecret`, and a webhook URL with
   `?access_token=` in the query string. All of it is one JSON string as far as a
   scanner is concerned.

5. **A private key with the armour stripped** — `local_file.deploy_key`. Real
   key material minus the `-----BEGIN OPENSSH PRIVATE KEY-----` line, which is
   exactly what the detector anchors on.

6. **A credential pair plus operational intelligence** —
   `aws_ssm_parameter.legacy_service_account`. `user:passphrase` in the value, and
   a description explaining it *cannot be rotated* and naming the open ticket.

7. **An IAM console password** — `aws_iam_user_login_profile.contractor`, with
   `password_reset_required: false`.

8. **Personal data** — `aws_s3_bucket_object.onboarding_export`. Personal email
   addresses, mobile numbers, home addresses, national insurance numbers and
   salaries, as CSV inside a state file. No scanner is looking for this, and it is
   arguably the most serious thing here.

9. **A vendor secret with a reason it will not be rotated** —
   `aws_secretsmanager_secret_version.vendor_api`. Custom-format API key, a 32-hex
   secret, and a note that the key also ships in the mobile app bundle.

10. **Secrets in outputs** — `runbook_note` puts a shared ops account in prose;
    `grafana_admin` is marked `sensitive: true` and the value is right there,
    which is the point about `sensitive`; `db_endpoint` leaks an internal hostname.

11. **Cross-references worth more than any single secret** — a tag saying the
    database password is duplicated in the CI project settings, and two notes
    saying a key cannot be rotated. None of it matches a pattern. All of it tells
    an attacker where to go next.

</details>

## Things to try next

- Ask the model which findings it would fail a build for, and which need a human.
- Ask it what to do about each one — rotation, `sensitive`, moving state to a
  backend with encryption and access control. Compare its answers to your own.
- Run it twice and diff the output. Non-determinism is part of what you are
  evaluating; a scanner does not have that property and this does.
- Write a deterministic check for one class above — base64 fields whose decoded
  content contains a `:` and a password-like word, say — and put it in
  `extensions/lib/`. That is the workshop's whole argument: once you know what you
  are looking for, stop asking a model to find it.
