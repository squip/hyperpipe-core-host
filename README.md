# @squip/hyperpipe-core-host

`@squip/hyperpipe-core-host` is the shared process launcher and IPC wrapper used by
first-party Hyperpipe hosts to start and communicate with `@squip/hyperpipe-core`.

The package exposes a shared host abstraction so Electron and TUI clients do not
need to maintain separate Core startup and IPC lifecycle implementations.
