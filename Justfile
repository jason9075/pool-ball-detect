set shell := ["bash", "-cu"]

default:
    @just --list

# node_modules must live off the noexec-mounted project partition (see
# README) — this symlinks it into an exec-enabled cache dir on first run.
install:
    @[ -e node_modules ] || (mkdir -p ~/.cache/pool-ball-detect/node_modules && ln -s ~/.cache/pool-ball-detect/node_modules node_modules)
    bun install

dev: install
    bun run dev

build: install
    NODE_ENV=production bun run build

preview: build
    bun run preview
