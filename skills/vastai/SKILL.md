---
name: vastai
description: Renting compute on Vast.ai without surprise bills. Use when searching, pricing, renting, labelling, debugging or destroying a Vast.ai box for a CPU or GPU job - how the marketplace and billing work, why core counts lie, how the vast_* tools rent a box under a budget the reader confirms and label it so prifly shows it on the session that rented it, and the create and ssh traps that leave you paying for nothing.
---

# Vast.ai

Vast.ai is a peer-to-peer marketplace: hosts list their own machines and you
rent a slice by the second. Quality varies from host to host, and so does
honesty about the hardware.

## Money
- **VAI-1 (MUST NOT)** Never rent, extend past its budget or destroy a box except through the `vast_*` tools. `vast_rent` shows the reader the offers and the budget on a card and waits; renting spends real money, and the amount the reader confirms is the box's hard limit. The plugin's hook refuses `vastai create`, `destroy`, `label` and the other writing commands, `vastlease`, and `curl -X PUT|POST|DELETE` to console.vast.ai, and names the tool to use.
- **VAI-2 (KNOW)** Billing is per second while running, disk only while stopped, nothing after destroy. No minimum period.
- **VAI-3 (MUST)** Tear down with `vast_cancel`, never by stopping: a stopped instance keeps billing for its disk. `vast_cancel` saves the box (VAI-L3) and destroys it within a minute.
- **VAI-4 (MUST)** Every box on the account draws on one credit: this prifly's boxes, other prifly's, boxes rented by hand and serverless endpoints' workers. When the credit drops below the account's `balance_threshold` (about $0), Vast stops every instance on the account at once, unrelated ones included, and stopped boxes still bill disk. `vast_rent` and `vast_extend`'s raise card show the reader what the credit covers after everything already committed and a margin; going past it takes their explicit "I will top up". The first line of `vast_boxes` gives the account's credit, burn, runway and committed spend: read it before a campaign, and size budgets to fit.
- **VAI-4a (KNOW)** Vast.ai has no API to add credit: the reader tops up in the console (console.vast.ai → Billing) or turns on its auto-billing. The extension sees a top-up on its next minute's poll. When a tool's result says a budget is over what the credit covers, tell the reader when the credit runs out and that they must top up before then.
- **VAI-5 (MUST)** Call `vast_boxes` at the start and end of any rental work (`vastai show instances` lists every box on the account, read-only). A box nobody claims is a bill nobody is watching: tell the reader, who can keep or destroy it from its menu in prifly.
- **VAI-6 (MUST)** For a job under an hour, weigh time-to-ready over hourly price: the box pulls its Docker image on start. Require a decent `inet_down` (`min_inet_down_mbps` in `vast_offers`) when the job pulls a large image or dataset.
- **VAI-B1 (MUST)** Suggest `vast_rent`'s budget from the job: its real length times the rate (the rate includes the disk), plus a margin, and say in `purpose` how you got it; the card shows that sentence under the amount. The reader may change the amount. The box is saved and destroyed when it has cost the confirmed amount, so a budget too small ends the job early.
- **VAI-B2 (KNOW)** The budget counts the hourly rate only: per-GB bandwidth charges some hosts add are not in it.
- **VAI-B3 (KNOW)** `vast_extend` is free while the box's cost to the new end stays within its budget; past that the reader is asked to raise the budget, and the box is extended only as far as the amount they confirm allows.

## Labels: which session owns a box
- **VAI-7 (KNOW)** Every box is labelled with its owner and the session that rents it: `<owner>/s-<first 8 characters of the session id>/<name>`, e.g. `alice/s-2b89f308/box1`. `vast_rent` builds it from the `name` you give; never build one by hand. The prifly Vast.ai extension shows each box on that session, boxes without such a label in the status bar as unclaimed, and boxes of another owner (another prifly on the same Vast.ai account) as that prifly's. The tools act only on this session's boxes.
- **VAI-8 (KNOW)** A label cannot be changed from a session. A box another session rented is that session's: ask the reader if it is to be handed over. Boxes without a session label (rented by hand or by other software) are never touched by the extension.
- **VAI-9 (MUST)** Keep `name` to at most 8 characters (the tool refuses longer), so short displays show it whole. Put what the box is for in `purpose` or your notes, not its name.

## Leases: how long a session may keep a box
The prifly Vast.ai extension destroys a box labelled `<owner>/s-<session>/<name>`
with its own owner that has no lease, whose lease ended more than 15 minutes
ago, or that has cost its budget. Boxes with other labels (rented by hand, or
by other software) are never touched, nor are boxes of another owner, nor
boxes of a session this prifly does not know (it only warns: "not this
prifly's session"). A box whose session stopped — a usage limit, a crash,
prifly closed — cannot extend its lease, so it goes when the lease ends; each
leased box also runs a guard (`/root/.lease/guard.sh`) that destroys it with
the box's own key if prifly is not running then. The lease's end is held to the
hour the budget runs out, so the guard enforces the budget too.

- `vast_rent` books the lease itself, before it creates the box: for the budget's hours, at most 24 hours ahead.
- `vast_extend <name> <hours>` adds hours while you still need the box; you are warned 15 minutes before the end.
- `vast_cancel <name>` when the work is done: saved and destroyed within a minute.
- `vast_boxes` shows each box's lease end, spend and the host's end date.
- **VAI-L4 (KNOW)** Every rental has a host end date, when Vast.ai stops the box. The box is saved and destroyed 30 minutes before it, even with lease left, and `vast_extend` stops there and says so. Results must be off the box by then.

- **VAI-L1 (MUST)** Never rent around `vast_rent`: a box without a lease has 5 minutes before it is destroyed.
- **VAI-L2 (MUST)** Cancel as soon as the work is done — an idle box inside its lease is only warned about, never destroyed, and bills until the lease or the budget ends.
- **VAI-L3 (MUST)** A box holding results gets a `/root/.lease/save` script (executable) that copies them off the box. It runs before every automatic destroy, for up to 10 minutes, and once more 10 minutes later if it fails; after that the box is destroyed anyway.

## Renting
The tools talk to Vast.ai with the API key `vastai set api-key <key>` stored in
`~/.config/vastai/vast_api_key`; the reader stores it once. Reading the
marketplace needs no key.

1. `vast_offers` with filters (GPU name, `min_vram_gb`, `min_cpu_cores`, `min_ram_gb`, `min_disk_gb`, `max_dph`, `min_reliability` default 0.98, `region`, `min_inet_down_mbps`, `min_hours`): the cheapest offers that pass, with their offer ids, time left before the host's end date, GPU perf (Vast's `dlperf`) and CPU perf (VAI-20, scaled to the rented threads, "unscored" for a chip PassMark lacks), each per $/h, memory GB/s and verification: rank on those, not on core count. The `vast_rent` card shows the same facts compactly (GPU perf · per $/h and CPU perf · per $/h in one cell each, "–" for an unscored CPU; Ends in as "14 d" or "7 h"; Where as the country code), and on a prifly with `pick-links` the GPU and CPU names link to their PassMark pages and the Offer id to Vast's console. Set `min_hours` to the job length: Vast stops a box at its offer's end date, and `vast_rent` refuses an offer that ends before its budget runs out plus an hour. For a CPU job, rank with the rules below and hand the chosen offer ids on.
2. `vast_rent` with `name`, `budget`, `offers` (ids, best first), `image`, `disk_gb`, `purpose`, and optionally `onstart`, `env`, `ports`. The reader answers on the card.
3. `vast_boxes` for its ssh address once it runs; `vast_logs <name>` if ssh still fails after 2 to 3 minutes. A box that turns out broken is replaced by itself (VAI-46).

`vastai show user`, `vastai show instances`, `vastai search offers` and `vastai logs` still work for reading.

- **VAI-10 (MUST)** The account needs an ssh key before renting: a new account has none (`vastai show user` prints `Ssh Key -`), and you get a box you cannot log into. The hook refuses `vastai create ssh-key` like any `create`: ask the reader to add the public key at the console's account page.
- **VAI-11 (KNOW)** `vast_rent` always sends `cancel_unavail`, so a lost race creates nothing; without it a lost race returns `success: False` and still creates a stopped instance on another machine, which bills disk until destroyed.
- **VAI-12 (MUST)** When `vast_rent` fails, call `vast_boxes` and `vastai show instances` to be sure nothing was left behind, and tell the reader what you find.
- **VAI-13 (KNOW)** Offers vanish between search and rent. `vast_rent` looks each offer up again, drops the gone ones, and if the chosen one is gone when the reader clicks, rents the next card row that fits the confirmed budget. Give it several offer ids, best first.
- **VAI-14 (KNOW)** `onstart` defaults to `sleep infinity`, cheap insurance: a bare image whose default command exits may not stay up. If you pass your own `onstart`, end it so the box stays up.
- **VAI-15 (KNOW)** A host can accept the contract and still fail to start the container (`unresolvable CDI devices`, status stuck at `created`). That is the host's driver setup. The plugin counts a box in `created` or `loading` for more than 10 minutes as broken and replaces it by itself (VAI-46): do not destroy it and re-rent by hand.
- **VAI-16 (KNOW)** `vast_logs` asks the host for a box's log and waits for the host to fill it in. If the log never appears, suspect the machine, not your image. Read it once ssh has failed for 2 to 3 minutes on a box that says `running`, not after 10: the plugin replaces the box at 3 minutes without you, and the log tells you why, for your report to the reader.
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
- **VAI-34 (MUST)** After 2 to 3 minutes of refused ssh on a `running` box, read `vast_logs <name>` with `tail` 400, to tell the reader why. With enforcement on and a box rented by `vast_rent` since replacements exist, the plugin replaces the box by itself at 3 minutes (VAI-46), so there is nothing to cancel or re-rent; otherwise (VAI-37) recovering it is yours. Do not re-attach keys, reboot or toggle the key in the console; each costs a billed round trip. Grep for `Hangup` too (VAI-38).
- **VAI-35 (KNOW)** The usual cause: `Authentication refused: bad ownership or modes for file /root/.ssh/authorized_keys`. The key is there and offered (compare the logged fingerprint with `ssh-keygen -lf <key>.pub`); sshd refuses the file's modes. Vast's own images work only because they set `StrictModes no`, so it depends on the image: `ubuntu:22.04` works where `vastai/base-image` CUDA tags have failed. Upstream: https://github.com/vast-ai/vast-cli/issues/336.
- **VAI-36 (MUST)** `vast_rent` does the repair by default on every box: it puts the repair on the first line of the `onstart`, ahead of whatever `onstart` you pass (or `sleep infinity` when you pass none), and it never includes `pkill` (VAI-38). The repair cannot stop your `onstart` from running, even when a path is missing or under `set -e`. Pass your own `onstart` as usual and do not add the repair yourself; every replacement (VAI-46) is created with the same `onstart`. A box whose log still shows this refusal is recreated by the plugin (VAI-46). It is exported as `SSH_KEY_REPAIR` in `rent.ts`:
```bash
{ chmod go-w /root; chmod 700 /root/.ssh; chmod 600 /root/.ssh/authorized_keys; sed -i "s/^#*[[:space:]]*StrictModes.*/StrictModes no/" /etc/ssh/sshd_config; } 2>/dev/null || true
```
  Changing a running box's onstart records the field but never runs it, not on reboot and not on stop then start, so a box created before this change still needs to be recreated (VAI-37).
- **VAI-37 (MUST)** With enforcement on, on a box rented by `vast_rent` since replacements exist, never cancel and re-rent a broken box by hand while its budget lasts: the plugin already has, from the same card, under the same name, and the reader is not asked again. The machine that failed is left out of the rent, so do not look for it again. Give `vast_rent` several offer ids on different machines (VAI-13) so there is something to replace with. Otherwise (enforcement off, an older or adopted box, or the limit or budget reached, VAI-47) recover by hand; recreating gives the offer back to the market: `vast_cancel` the box, find the same machine again with `vast_offers` (its offer id may change, so look it up by its host and GPU) and `vast_rent` it at once; the reader confirms the budget again. Do it in one go: the offer can be taken by someone else the moment it is released, and there may be no comparable machine to fall back on.
- **VAI-38 (MUST NOT)** Never send `pkill -HUP sshd` on an image where Vast's `/.launch` runs sshd in the foreground (`sshd -E /proc/1/fd/1`): the `*-auto` CUDA base images, and any image that already ships openssh-server (e.g. `vllm/vllm-openai`). The HUP kills sshd, the box still says `running`, ssh gets `Connection reset` or refused, and the log shows `Hangup /usr/sbin/sshd`. Only `vast_cancel` and a new `vast_rent` recovers it. The VAI-36 repair has no `pkill` for this reason; do not add one to your own `onstart`. On an image that already has this problem, use `ubuntu:22.04`.
- **VAI-39 (KNOW)** `connect_to localhost port 22: failed` repeated in the log means no sshd is running (VAI-38), not the key problem. `vastai execute` is no way in (the hook refuses it): it runs only on stopped instances and rejects `chmod`.
- **VAI-41 (KNOW)** A repair that worked: the same machine, image and key, recreated with the VAI-36 repair at the start of its `onstart`, authenticated on the first ssh attempt, with `/root` and `/root/.ssh` at `700`, the key at `600` and `StrictModes no` in `sshd_config`. Which half of the repair matters was never isolated, so keep both.

## A broken box is replaced for you
- **VAI-46 (KNOW)** A box counts as broken when it is `running` but ssh is refused or times out for 3 minutes without once getting in, when its log shows `bad ownership or modes`, or when it stays in `created` or `loading` for more than 10 minutes. The plugin then cancels it as `vast_cancel` does (so `/root/.lease/save` runs), leaves its machine out of the rent, and rents the next offer of the same card under the same name, with the confirmed budget minus what the rent's boxes have already cost. It tells the session the reason and the new box's ssh command, and `vast_boxes` shows `replaces #<old> — <reason>`. Only with enforcement on, and only for a box rented by `vast_rent`.
- **VAI-47 (KNOW)** It stops after 3 replacements, or when no offer on the card fits what is left of the budget, and says so in one message. Then the reader's budget for that rent is used up: say what happened and what you suggest, and start a new `vast_rent` card only if they want one. A box that let ssh in once is never replaced for ssh later, but that memory is lost when prifly restarts: a box under an hour old that loses ssh for 3 minutes after a restart (a proxy drop, VAI-18, or a network outage) can be replaced although it worked.
- **VAI-48 (MUST NOT)** With enforcement on and a box the plugin replaces (VAI-46), never re-rent by hand within the budget and never cancel a box it is replacing: wait for its message, or read `vast_boxes`. A replacement is a new box with a new ssh port: take it from `vast_boxes`, not from the old command.

## Cleaning up and rebuilding
- **VAI-42 (MUST)** Do not keep an idle box alive to save its disk: a stopped instance bills for the disk (VAI-3), and some other clouds bill stopped instances at a higher rate still. Keep the inputs in object storage or a repository, give the job a bootstrap script that takes a fresh box to the point of working, and destroy the box when the job ends.
- **VAI-43 (KNOW)** A credit below the account threshold stops every instance, boxes unrelated to the job included (VAI-4); the extension warns at 12, 3 and 1 hours of runway, but only warns. Check the account line of `vast_boxes` before a campaign, not after boxes go down.

## ssh aliases for rented boxes
- **VAI-44 (MUST NOT)** Never paste a `Host` block at the top of `~/.ssh/config`, above the global defaults. In ssh config a setting belongs to the nearest `Host` line above it, so `ForwardAgent yes` quietly becomes a setting of that one host and every other host loses it; the symptom (say `git@github.com: Permission denied (publickey)` on another machine) is far from the cause. Keep one file per box in an included directory such as `~/.ssh/config.d/`, or put `Host *` defaults first.
- **VAI-45 (KNOW)** `ssh -G <host> | grep -iE '^forwardagent|^addressfamily'` prints what ssh will really apply to a host. A `Host`, `HostName` or `Port` line with no value breaks every ssh command with `line N: Missing argument`: a generator must skip a box until its host and port are both known.

## Editing this file
- **VAI-40 (MUST NOT)** Never write a dollar sign directly followed by a digit in a skill file: the loader treats those as argument placeholders and splices the invocation's arguments in. Write prices in words or put the currency after the number.
