# One module owns the Work record

Every Work leaves a record on disk under `trabalhos/<key>/`: the outcome
(`desfecho.json`), the continuity pause (`pausa.json`), the effect journal
(`efeitos.jsonl`), the session links (`sessao-vinculos.jsonl`), the guardrail
state (`continuidade.json`), the recovery and model-provider ledgers
(`recuperacao.json`, `provedor.json`), the Repair cycle (`reparo.json`), the
attempt event and Sandcastle logs (`log-<n>.jsonl`, `sandcastle-<n>.log`), the
Pi sessions and the evidence locations. We decided one module (`src/work-record/`)
owns that whole record: its files, their schemas and the cross-references that
bind them — a pause names its Attempt, a session link names its round, an
outcome settles a pause, a stop fact names the attempt it ended, a Repair
attempt names the evidence it addresses and the head it observed. Its interface
is small: `openWorkRecord(workDir)` returns `read()` — the whole record, with
absent and unreadable parts told apart and never invented — and `write(part)` —
persist one part, refusing one that would break a cross-reference before the
disk is touched.

The domain modules keep their policy: the outcome ruler (`state/outcome.ts`),
the recovery decision (`pool/recovery.ts`), the model-provider decision
(`pool/model-provider.ts`) and the Repair reconciliation (`pool/repair.ts`)
still decide and read the record through the interface. The migration landed in
expand steps: the artifact modules briefly became thin re-exports, so no
consumer changed while the derivation, the loop, the runtime and the guardrail
migrated in green batches. The guardrail reaches the same module the host does,
so container and host cannot diverge on the artifact format. ADR 0002 (status
reads the artifacts read-only) and ADR 0005 (the recovery resumes the attempt's
own session from its recorded association) already argue for a single owner;
neither is reopened.

Contract : the compatibility re-exports were deleted. Every record
part is imported from `src/work-record/`; the container guardrail reaches
`work-record/continuity.ts` directly, through the import closure the image
staging and the launch preflight compute.

The trade-off is accepted for locality: the record is now many small part files
behind one interface instead of schemas spread across three subsystems that
imported each other's internals — the code's only real module cycle. A schema
change, a reader fix or a new cross-reference lands in one place, and a fixture
can write the real shapes through one import.

Rejected: **one monolithic record file**, because the pause, journal, ledger and
Repair schemas carry different durability rules (fsynced appends, atomic
replaces, one-writer queues) and merging them would make the module one large
surface and drag recovery, model-provider and Repair code into the worker
image's guardrail closure. Rejected: **per-artifact owners with cross-imports**
(the state before this decision), which produced the cycle
`state/outcome ↔ pool/recovery`, duplicate readings of the same artifact, and
cross-references that depended on which caller wrote the file. Rejected: **an
external store or database**, because the workspace is already a directory on
the host and a bind mount in the container, the record must survive a factory
death with no daemon to operate, and the guardrail must read it inside the
container. Rejected: **passing the record through callers**, because threading
one object through the loop hides the dependency without giving the record an
owner — every caller still needs the schema to build it, and the container side
cannot receive the host's object.
