import algosdk from 'algosdk'
import { describe, expect, test, vi } from 'vitest'
import { getABIDecodedValue, getABIStructFromABITuple, getABITupleTypeFromABIStructDefinition, StructField } from './app-arc56'

// Offline tests of the ARC-56 decoding helpers, which reuse their parsed ABI types.

const structs: Record<string, StructField[]> = {
  Inner: [
    { name: 'id', type: 'uint16' },
    { name: 'tag', type: 'byte[2]' },
  ],
  Outer: [
    { name: 'total', type: 'uint64' },
    { name: 'inner', type: 'Inner' },
    { name: 'names', type: 'string[]' },
    {
      name: 'pair',
      type: [
        { name: 'a', type: 'uint8' },
        { name: 'b', type: 'address' },
      ],
    },
  ],
}
const address = algosdk.generateAccount().addr.toString()
const outerType = algosdk.ABIType.from('(uint64,(uint16,byte[2]),string[],(uint8,address))')
const encoded = outerType.encode([7n, [3, [1, 2]], ['x', 'yz'], [5, address]])
const expected = { total: 7n, inner: { id: 3, tag: new Uint8Array([1, 2]) }, names: ['x', 'yz'], pair: { a: 5, b: address } }

describe('ARC-56 decoding', () => {
  test('a nested struct decodes the same on every call, parsing its types once', () => {
    const from = vi.spyOn(algosdk.ABIType, 'from')
    try {
      const results = [1, 2, 3].map(() => getABIDecodedValue(encoded, 'Outer', structs))
      for (const r of results) expect(r).toEqual(expected)
      expect(results[0]).not.toBe(results[1])
      const parsed = from.mock.calls.map(([t]) => t)
      expect(new Set(parsed).size).toBe(parsed.length)
    } finally {
      from.mockRestore()
    }
  })

  test('plain ABI types decode the same on every call', () => {
    const bytes = algosdk.ABIType.from('byte[3]').encode([9, 8, 7])
    expect(getABIDecodedValue(bytes, 'byte[3]', {})).toEqual(new Uint8Array([9, 8, 7]))
    expect(getABIDecodedValue(bytes, 'byte[3]', {})).toEqual(new Uint8Array([9, 8, 7]))
    expect(getABIDecodedValue(algosdk.encodeUint64(2n ** 60n), 'AVMUint64', {})).toBe(2n ** 60n)
    expect(getABIDecodedValue(new algosdk.ABIUintType(32).encode(4), 'uint32', {})).toBe(4)
  })

  test('the parsed type cache stays bounded and keeps decoding right', () => {
    for (let n = 1; n <= 1100; n++) getABIDecodedValue(new Uint8Array(n), `byte[${n}]`, {})
    const bytes = algosdk.ABIType.from('byte[3]').encode([9, 8, 7])
    expect(getABIDecodedValue(bytes, 'byte[3]', {})).toEqual(new Uint8Array([9, 8, 7]))
  })

  test('struct tuple types are shared per structs object and definition, and match a fresh parse', () => {
    const tuple = getABITupleTypeFromABIStructDefinition(structs.Outer, structs)
    expect(getABITupleTypeFromABIStructDefinition(structs.Outer, structs)).toBe(tuple)
    expect(tuple.toString()).toBe(outerType.toString())
    // Another structs object with the same name meaning something else gets its own type
    const other: Record<string, StructField[]> = { ...structs, Inner: [{ name: 'flag', type: 'bool' }] }
    expect(getABITupleTypeFromABIStructDefinition(other.Outer, other).toString()).toBe('(uint64,(bool),string[],(uint8,address))')
    expect(getABIStructFromABITuple(tuple.decode(encoded), structs.Outer, structs)).toEqual(expected)
  })
})
