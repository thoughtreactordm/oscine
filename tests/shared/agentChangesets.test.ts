import { describe, expect, it } from 'vitest'
import { describeRevert, type AgentRevertResult } from '@shared/agentChangesets'

/** The revert summary Settings shows under a changeset — W24-6. */
describe('describeRevert', () => {
  const result = (partial: Partial<AgentRevertResult>): AgentRevertResult => ({
    changesetId: 1,
    restored: 0,
    skipped: 0,
    skippedChanges: [],
    ...partial
  })
  const conflict = { kind: 'override', entityId: 1, field: 'title', reason: 'conflict' } as const

  it('says when there was nothing left', () => {
    expect(describeRevert(result({}))).toBe('Nothing left to revert.')
  })

  it('counts restored changes', () => {
    expect(describeRevert(result({ restored: 3 }))).toBe('3 restored.')
  })

  it('names edits since as the reason when every skip was a conflict', () => {
    expect(describeRevert(result({ restored: 2, skipped: 1, skippedChanges: [conflict] }))).toBe(
      '2 restored, 1 skipped because it was edited since.'
    )
  })

  it('stays general when skips had other reasons', () => {
    expect(
      describeRevert(
        result({
          restored: 0,
          skipped: 2,
          skippedChanges: [conflict, { ...conflict, reason: 'failed' }]
        })
      )
    ).toBe('0 restored, 2 skipped.')
  })
})
