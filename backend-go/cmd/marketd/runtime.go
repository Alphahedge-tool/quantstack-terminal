package main

import "runtime"

// Thin wrappers so main.go does not import runtime for two constants, and so a
// health payload's shape is defined in one place.
func runtimeVersion() string { return runtime.Version() }
func cores() int             { return runtime.GOMAXPROCS(0) }
