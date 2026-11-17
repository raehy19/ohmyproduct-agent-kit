#!/usr/bin/env node
import { defaultIo, run } from './cli.js'

run(process.argv.slice(2), defaultIo()).then(
  (code) => {
    process.exitCode = code
  },
  (error: unknown) => {
    process.stderr.write(`omp: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  },
)
