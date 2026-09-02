import { expect, test } from 'vitest'
import { installSubCli } from './install-sub-cli-core.mjs'

test('imports the portable sub CLI installer core', () => {
  expect(typeof installSubCli).toBe('function')
})
