# Worker model is factory configuration

Accepted for [issue #88](https://github.com/Sanmoo/my-software-factory/issues/88).

The factory's worker model is configured by the required `worker-model` field
in `msf.yaml`, with a `<provider>/<model-id>` value. The CLI does not accept a
model-selection flag. Configuration validation rejects missing, blank, or
malformed values before workspace creation or credential access.

The factory currently has one model consumer: the Pi session of each worker.
The orchestrator uses structured facts rather than an LLM, and `msf status`
does not use a model. A future reviewer model, if needed, will be a sibling
configuration key rather than a nested model map.

Rejected alternative: selecting the model with `msf run --model ...`. The
model is a property of the configured factory, not of an individual
invocation; a CLI flag also makes continuous runs and `status` config
inconsistent and permits accidental per-launch drift. There is no default:
choosing a provider/model in code would become a silently aging policy.
