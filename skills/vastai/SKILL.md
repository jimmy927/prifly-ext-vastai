---
name: vastai
description: Renting compute on Vast.ai without surprise bills. Use when searching, pricing, renting, labelling, debugging or destroying a Vast.ai box for a CPU or GPU job - how the marketplace and billing work, why core counts lie, how to label a box so prifly shows it on the session that rented it, and the create and ssh traps that leave you paying for nothing.
---

# Vast.ai

Vast.ai is a peer-to-peer marketplace: hosts list their own machines and you
rent a slice by the second. Quality varies from host to host, and so does
honesty about the hardware.

## Money
- **VAI-1 (MUST NOT)** Never create, rent or destroy an instance without the user's explicit go-ahead for that specific box. Renting spends real money.
- **VAI-2 (KNOW)** Billing is per second while running, disk only while stopped, nothing after destroy. No minimum period.
- **VAI-3 (MUST)** Tear down with `destroy`, never `stop`: a stopped instance keeps billing for its disk.
- **VAI-4 (MUST)** Before starting several boxes, check `vastai show user --raw` for `balance` and keep it above the whole job's budget. When the balance drops below the account's `balance_threshold`, Vast stops every instance on the account at once, unrelated ones included, and stopped boxes still bill disk.
- **VAI-5 (MUST)** Run `vastai show instances` at the start and end of any rental work. A box nobody claims is a bill nobody is watching: claim it (VAI-8) or, with the user's go-ahead, destroy it.
- **VAI-6 (MUST)** For a job under an hour, weigh time-to-ready over hourly price: the box pulls its Docker image on start. Require a decent `inet_down` when the job pulls a large image or dataset.

## Labels: which session owns a box
- **VAI-7 (MUST)** Label every box with the session that rents it: `s-<first 8 characters of the session id>/<name>`. In a shell: `--label "s-${CLAUDE_CODE_SESSION_ID:0:8}/<name>"`. The prifly Vast.ai extension shows each box on that session, and boxes without such a label in the status bar as unclaimed.
- **VAI-8 (KNOW)** Relabel with `vastai label instance <id> s-<8 chars>/<name>`. A box handed to another session gets that session's id.
- **VAI-9 (MUST)** Keep `<name>` to at most 8 characters, so short displays show it whole. Put what the box is for in your notes, not its name.

## Renting
The CLI is `pip install vastai`; `vastai set api-key <key>` stores the key in
`~/.config/vastai/vast_api_key`. Reading the marketplace needs no key.

```bash
vastai show user                                   # credit, and whether an ssh key is registered
vastai create ssh-key "$(cat ~/.ssh/<your_key>.pub)" -y
vastai search offers 'rentable=true num_gpus>=1 reliability>0.98' -o 'dph_total'
vastai create instance <offer> --image ubuntu:22.04 --disk 40 --ssh --direct \
   --onstart-cmd 'sleep infinity' --cancel-unavail --label "s-${CLAUDE_CODE_SESSION_ID:0:8}/<name>"
yes y | vastai destroy instance <id>               # destroy asks for confirmation
```

- **VAI-10 (MUST)** Register an ssh key before renting. A new account has none (`show user` prints `Ssh Key -`), and you get a box you cannot log into.
- **VAI-11 (MUST)** Always pass `--cancel-unavail`. Without it a lost race returns `success: False` and still creates a stopped instance on another machine, which bills disk until destroyed.
- **VAI-12 (MUST)** After any create that did not return `success: True`, run `show instances` and destroy whatever it left behind.
- **VAI-13 (MUST)** Offers vanish between search and create. Re-check `rentable` right before creating, expect to lose anyway, and have the next candidate ready.
- **VAI-14 (KNOW)** `--onstart-cmd 'sleep infinity'` is cheap insurance: a bare image whose default command exits may not stay up.
- **VAI-15 (KNOW)** A host can accept the contract and still fail to start the container (`unresolvable CDI devices`, status stuck at `created`). That is the host's driver setup: destroy at once and take the next candidate.
- **VAI-16 (KNOW)** For a box that never reaches `running`, `vastai logs <id>` returns a URL the host must fill. If the log never appears, suspect the machine, not your image.
- **VAI-17 (KNOW)** For a PyTorch GPU job, `ubuntu:22.04` is enough: the container runtime provides `nvidia-smi`, and `pip install torch` brings its own CUDA libraries.
- **VAI-18 (KNOW)** A script that polls a box over ssh must treat an ssh failure as "unknown", never as "process exited": Vast's proxy can drop every session at once, and a naive poll then tears down healthy work.

## Choosing an offer
- **VAI-19 (MUST NOT)** Never compare offers on core count. A 2014 Xeon E5-2699 v3 and a 2023 Ryzen 9 7945HX both advertise about 32 threads and differ by 2.7x in real work.
- **VAI-20 (KNOW)** A usable CPU measure: the chip's PassMark multithread score, divided by its thread count, times `cpu_cores_effective` (the threads you rent; `cpu_cores` is the whole machine). Divide by `dph_total` for value. PassMark's `high_end_cpus.html` and `singleThread.html` on cpubenchmark.net can be fetched; the full "mega" page returns 403.
- **VAI-21 (MUST)** Sanity-check any per-thread score against a chip of the same generation and clock before trusting it. PassMark sometimes measures a chip on a cloud slice: its AMD EPYC 9K84 entry was measured on 16 threads, which made it look 2.6x faster per thread than a 9654 at the same clock. A wrong thread count scales the whole ranking.
- **VAI-22 (MUST NOT)** When a score looks wrong, never quietly fall back to core count or price per core. Say which measure you are substituting and why it holds for those rows (same microarchitecture and clock is a reason; "more cores" is not).
- **VAI-23 (KNOW)** Single-thread score matters whenever each worker runs one thread: equal multithread totals can behave very differently. New EPYC parts and cloud SKUs often have no PassMark entry; list them as unscored, never drop them silently.
- **VAI-24 (KNOW)** A benchmark beats core count by a mile but does not replace timing the real job.
- **VAI-25 (MUST)** Treat reliability as a floor (0.98), never as something to trade against price. Below it hosts drop jobs.
- **VAI-26 (MUST NOT)** Never filter or rank a CPU job on verification. It is a GPU-oriented rating (DLPerf and demand count toward it); insisting on it roughly halves the pool. Of its states, `deverified` (passed once, failing now) is a worse sign than `unverified` (never assessed).
- **VAI-27 (MUST)** When the job needs a minimum VRAM, filter on `gpu_ram`. The same GPU name ships in several sizes (an RTX A2000 is 6 or 12 GB).
- **VAI-28 (KNOW)** The cheap way to buy CPU is a box with an old, cheap GPU and many cores: often an order of magnitude cheaper per unit of work than dedicated cloud vCPUs, on weaker silicon and with no SLA.
- **VAI-29 (MUST NOT)** Never treat `num_gpus=0` rows as CPU-only machines. They are the leftover zero-GPU chunk of a GPU box, report RAM as 0, and Vast documents no CPU-only product.
- **VAI-30 (KNOW)** One physical machine appears under several `ask_contract_id`s. Consecutive rows with identical specs and price are one option.

## Offer API
The search is a GET with the query as URL-encoded JSON, no key needed:

```bash
curl -sG 'https://console.vast.ai/api/v0/bundles/' --data-urlencode \
 'q={"rentable":{"eq":true},"num_gpus":{"gte":1},"limit":64,"type":"ask"}'
```

- **VAI-31 (MUST)** Every response stops at 64 offers whatever `limit` says. Widen the pool by re-running under different `order` keys and merging on `ask_contract_id`.
- **VAI-32 (MUST)** `id` is not queryable; look an offer up by `ask_contract_id` or `machine_id`.
- **VAI-33 (KNOW)** The server's `dph_total` filter matches the rate before the storage charge, so it lets offers through slightly above your cap. Re-check locally.

## `Permission denied (publickey)` on a new box
- **VAI-34 (MUST)** Read `vastai logs <id> --tail 400` first. Do not re-attach keys, reboot or toggle the key in the console; each costs a billed round trip. Grep for `Hangup` too (VAI-38).
- **VAI-35 (KNOW)** The usual cause: `Authentication refused: bad ownership or modes for file /root/.ssh/authorized_keys`. The key is there and offered (compare the logged fingerprint with `ssh-keygen -lf <key>.pub`); sshd refuses the file's modes. Vast's own images work only because they set `StrictModes no`, so it depends on the image: `ubuntu:22.04` works where `vastai/base-image` CUDA tags have failed. Upstream: https://github.com/vast-ai/vast-cli/issues/336.
- **VAI-36 (MUST)** The only fix is to recreate with the repair as `--onstart-cmd` at creation. `update instance --onstart` records the field but never runs it, not on reboot and not on stop then start. On a `vastai/base-image` tag, pass it on every create up front, leaving out the final `pkill` on `*-auto` tags (VAI-38):
```bash
--onstart-cmd 'chmod go-w /root; chmod 700 /root/.ssh; chmod 600 /root/.ssh/authorized_keys; sed -i "s/^#*[[:space:]]*StrictModes.*/StrictModes no/" /etc/ssh/sshd_config; pkill -HUP sshd'
```
- **VAI-37 (MUST)** Recreating gives the offer back to the market. Do it in one script: destroy, poll by `machine_id` (the contract id may change) until it is rentable, create at once.
- **VAI-38 (MUST NOT)** Never send `pkill -HUP sshd` on an image where Vast's `/.launch` runs sshd in the foreground (`sshd -E /proc/1/fd/1`): the `*-auto` CUDA base images, and any image that already ships openssh-server (e.g. `vllm/vllm-openai`). The HUP kills sshd, the box still says `running`, ssh gets `Connection reset` or refused, and the log shows `Hangup /usr/sbin/sshd`. Only destroy and recreate recovers it. There, drop the `pkill` from VAI-36, or use `ubuntu:22.04`.
- **VAI-39 (KNOW)** `connect_to localhost port 22: failed` repeated in the log means no sshd is running (VAI-38), not the key problem. `vastai execute` is no way in: it runs only on stopped instances and rejects `chmod`.

## Editing this file
- **VAI-40 (MUST NOT)** Never write a dollar sign directly followed by a digit in a skill file: the loader treats those as argument placeholders and splices the invocation's arguments in. Write prices in words or put the currency after the number.
