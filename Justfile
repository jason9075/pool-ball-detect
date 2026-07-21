set shell := ["bash", "-cu"]

default:
    @just --list

install:
    bun install

dev:
    bun run dev

build:
    bun run build

preview:
    bun run preview
