# The worker inherits the host Docker daemon

A worker container had no Docker: a round whose work needed it (issue 113's
quality gateway runs the repo's real Docker test) self-reported blocked, and
nothing in the container could tell "this repository needs Docker" from "this
host has none". The factory's work now and then IS running containers, so the
worker needs a daemon.

We bind the host's daemon socket into every worker container and add the
socket's own gid as a supplementary group (`--group-add`), with `DOCKER_HOST`
naming the same path inside the container. The image carries the docker client
and its buildx plugin, never a daemon of its own.

A real inner daemon (dockerd started inside the worker, "Docker-in-Docker" in
the strict sense) was rejected: it needs `--privileged` (or CAP_SYS_ADMIN plus
netfilter), the runtime's docker provider exposes no such flag, and a nested
daemon would add its own storage driver, iptables and boot time to every
launch. Rootless dockerd was rejected as well — it needs user-namespace
support the sandbox does not reliably have. What the worker loses is isolation
from the host daemon; what it gains is that it is a first-class client of the
same daemon the factory itself uses, which is what running the factory's own
Docker checks means.

Consequences, stated so nobody rediscovers them as bugs:

- **Containers the worker starts are the host's siblings**, created by the host
  daemon. A bind path a worker passes resolves on the HOST: paths the runtime
  already mirrors (the worktree, `<workspace>`) work, container-only paths
  (`/msf-work`, the container's `/tmp`) resolve to something else or to an
  empty directory.
- **The worker is root-equivalent on this host.** Reading the daemon socket is
  that power; it is the same accepted risk class as the operator PAT riding
  inside the container (see RUNBOOK).
- **No socket, no launch.** The preflight refuses before any artifact: a
  daemon reached over tcp (`DOCKER_HOST=tcp://…`) has no socket to bind, a
  missing socket would land as an empty mount, an image without the client or
  without the buildx builder would hand the worker Docker-shaped tools that
  cannot do the mandated `npm run build:image`, and a socket the container user
  cannot read is the same hole. All of them are named at boot, with what
  actually failed, instead of becoming a blocked round.
- **The real-model proof (`npm run proof:real`) is an operator-machine run.**
  Its disposable repo and work dir live under the test's own temp dir, which a
  worker container does not share with the host: launched from inside a worker,
  the nested worker's binds would resolve on the host to empty directories.
  The proof refuses to start in a container and says so.
- **The client need not match the server.** The CLI negotiates the API version,
  so Debian's client talks to whatever daemon the host runs; buildx is what
  `docker build` drives, which is the `npm run build:image` path.
