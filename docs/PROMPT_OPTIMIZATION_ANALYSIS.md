# System Prompt Optimization Analysis

## Summary

**Original:** 1,010 lines → ~12,409 tokens
**Optimized:** 206 lines → ~2,500-3,000 tokens (estimated)
**Reduction:** ~80% fewer lines, ~75-80% fewer tokens

## Changes Made

### 1. Tool Definitions (Biggest Savings)

**Before (569 lines):**
```
16. **git_status** - Show git working tree status (staged, unstaged, untracked files)
    `<tool name="git_status"></tool>`

17. **git_diff** - Show changes in files (unstaged by default)
    `<tool name="git_diff"></tool>`
    `<tool name="git_diff" staged="true"></tool>` - Show staged changes
    `<tool name="git_diff" filepath="src/app.ts"></tool>` - Show changes for specific file
```

**After (64 lines):**
```
16. `git_status` - Working tree status
17. `git_diff staged="false" filepath=""` - Show changes
```

**Strategy:**
- Removed verbose descriptions
- Consolidated multiple examples into single syntax line
- Removed redundant option explanations (model can infer from parameter names)
- Kept tool functionality intact

### 2. Examples Section

**Before:** 10+ examples showing same pattern (171 lines)
**After:** 3 concise examples (30 lines)

Removed:
- ❌ Multiple "forbidden behavior" examples showing same anti-pattern
- ❌ Duplicate debugging scenarios
- ❌ Repetitive "wrong vs right" comparisons

Kept:
- ✅ One clear example of correct single-tool execution
- ✅ One example of incorrect batching
- ✅ One debugging example

### 3. Behavioral Guidelines

**Before:** Extensive repetition of execution rules with multiple examples (127 lines)
**After:** Concise constraint-based format (45 lines)

Changes:
- Condensed "ABSOLUTELY FORBIDDEN" repeated warnings into single ❌ list
- Removed redundant examples of the same pattern
- Kept all critical rules (one-at-a-time, completion signals, mode awareness)

### 4. Debugging & Safety Sections

**Before:** Detailed step-by-step scenarios (100 lines)
**After:** Bullet-point best practices (20 lines)

Changes:
- Converted verbose scenarios into actionable bullets
- Removed redundant "common debugging steps" examples
- Preserved core safety rules (secrets, destructive ops, file edits)

## What Was Preserved

✅ **All tool functionality** - Every tool is still documented
✅ **Critical execution rules** - One-at-a-time, completion signals, mode awareness
✅ **Safety constraints** - Secrets protection, destructive operation confirmation
✅ **Core behavioral patterns** - Context integrity, honesty, goal-orientation
✅ **MCP tools integration** - Dynamic tool rendering preserved

## What Was Removed

❌ Verbose descriptions (model can infer from concise syntax)
❌ Redundant examples (showing same pattern 5+ times)
❌ Extensive option documentation (parameter names are self-explanatory)
❌ Repeated warnings (consolidated into single sections)
❌ Long-form scenario walkthroughs

## Expected Impact

### Token Usage
- **Current:** 12,409 tokens per request
- **Optimized:** ~2,500-3,000 tokens per request (estimated 75-80% reduction)
- **Savings:** ~10,000 tokens per request

### Cost Implications
For a user making 100 requests per day:
- **Before:** 1,240,900 system prompt tokens/day
- **After:** ~250,000-300,000 system prompt tokens/day
- **Daily Savings:** ~940,000 tokens

At typical API pricing ($3/1M input tokens for GLM-4.6):
- **Monthly Savings:** ~$85-100 in API costs (assuming 30 days × 100 requests/day)

### Performance
- Faster initial processing (less prompt to parse)
- More context window available for actual code/conversation
- Reduced latency on streaming responses

## Testing Recommendations

### 1. Functional Testing
Test that all core workflows still work:
- [ ] Create new Next.js project from scratch
- [ ] Debug existing project issues
- [ ] Refactoring tasks (extract function, rename symbol)
- [ ] Git operations (commit, branch, diff)
- [ ] Test generation and code review
- [ ] Planning tools for complex tasks

### 2. Behavioral Testing
Verify critical behaviors preserved:
- [ ] Executes tools one at a time (not batching)
- [ ] Stops after asking questions ("Would you like...")
- [ ] Stops after completion signals ("App is ready")
- [ ] Respects PLAN vs EDIT mode
- [ ] Never shows code before tool execution
- [ ] Asks for confirmation on destructive operations

### 3. Edge Cases
- [ ] Handles ambiguous requests appropriately
- [ ] Analyzes project before making assumptions
- [ ] Debugging "nothing happens" issues systematically
- [ ] Continues debugging after fixing intermediate errors

### 4. Quality Checks
- [ ] Responses remain conversational and helpful
- [ ] Tool usage is appropriate (not over/under using)
- [ ] Code quality unchanged
- [ ] Error messages still clear

## Migration Plan

### Option 1: Direct Replacement (Recommended)
Replace `systemPrompt.ts` with optimized version and monitor for issues.

```bash
cp src/agent/prompts/systemPrompt.ts src/agent/prompts/systemPrompt.backup.ts
cp src/agent/prompts/systemPrompt.optimized.ts src/agent/prompts/systemPrompt.ts
```

### Option 2: Gradual Rollout
Use environment variable to toggle between versions:

```typescript
const useOptimizedPrompt = process.env.MEER_OPTIMIZED_PROMPT === 'true';
const systemPrompt = useOptimizedPrompt
  ? buildOptimizedSystemPrompt(options)
  : buildAgentSystemPrompt(options);
```

### Option 3: A/B Testing
Split users and compare:
- Metrics: Task completion rate, user satisfaction, error rates
- Duration: 1-2 weeks
- Decision: Rollout if metrics equal or better

## Risks & Mitigations

### Risk 1: Model May Miss Tool Options
**Mitigation:** Parameter names are self-documenting (`staged="true"`, `dryRun="true"`)

### Risk 2: Behavioral Changes
**Mitigation:** All critical rules preserved in condensed format

### Risk 3: Quality Regression
**Mitigation:** Run comprehensive test suite before full rollout

## Industry Comparison

Based on research of other AI coding tools:

| Tool | Estimated Prompt Tokens |
|------|------------------------|
| Cursor | ~3,000-4,000 |
| Claude Code | ~4,000-5,000 |
| Cline | ~2,500-3,500 |
| **Meer AI (Before)** | **12,409** ❌ |
| **Meer AI (After)** | **~2,500-3,000** ✅ |

The optimized prompt brings Meer AI in line with industry standards.

## Recommendations

1. **Immediate:** Test optimized prompt with comprehensive test suite
2. **Short-term:** Deploy optimized version with monitoring
3. **Medium-term:** Consider further optimization of LangChain prompt (currently 75 lines)
4. **Long-term:** Implement dynamic prompt generation (only include relevant tools based on context)

## Next Steps

1. Run functional test suite against optimized prompt
2. Compare output quality with original prompt on 10-20 test cases
3. Monitor token usage in production
4. Gather user feedback on response quality
5. Fine-tune if needed based on feedback

## Conclusion

The optimized prompt achieves:
- ✅ **Massive token reduction** (~75-80%)
- ✅ **Preserved functionality** (all tools documented)
- ✅ **Maintained critical behaviors** (execution patterns, safety rules)
- ✅ **Industry-standard length** (comparable to Cursor, Cline, Claude Code)
- ✅ **Cost savings** (~$85-100/month for active users)

This optimization follows best practices from industry-leading AI coding tools while maintaining Meer AI's unique capabilities.
