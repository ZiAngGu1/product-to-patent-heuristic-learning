# Product-to-Patent Risk Screening Skill

This skill is the maintained learning object for product-to-patent infringement risk screening. It must generalize across products and must not memorize benchmark answers, product-specific shortcuts, patent numbers, hidden targets, or score-report facts.

## Task

Given product evidence, find invention / utility patent candidates that may matter for product infringement-risk review.

Product evidence may include:

- product image
- product URL
- marketplace page
- product description
- brand, seller, model, manual, package, or visible feature clues

Return patent identifiers in exactly two buckets:

```text
HIGH_RISK:
<direct or close-risk patent numbers, or NONE>

RELATED:
<related / weaker-context patent numbers, or NONE>
```

`HIGH_RISK` means the candidate has a strong bridge to the specific product and should be prioritized for analyst or attorney review. It is not a final infringement or FTO conclusion.

`RELATED` means the candidate is useful context: same owner, same family, counterpart, adjacent mechanism, lower-status record, foreign-only record, design bridge, or background patent. It is not strong enough to be treated as high risk.

## Core Protocol

1. Lock product identity before searching broadly.
   - Identify the exact product, brand, seller, model, visual modules, function, and use context.
   - For image-only or ambiguous evidence, state alternate hypotheses checked before committing.

2. Separate patent lanes.
   - Invention / utility patents are the main risk-screening target.
   - Design patents can help product identity or context, but do not replace invention / utility risk analysis.

3. Search in stages.
   - Direct product marking, package, manual, support page, patent notice.
   - Brand / owner / assignee / inventor bridge.
   - Product mechanism and visible module queries.
   - Family, counterpart, continuation, publication / grant bridge.
   - Bounded functional fallback only after direct anchors fail.

4. Compare evidence before bucketing.
   - Product identity
   - owner / assignee / inventor bridge
   - patent type
   - claim or abstract fit
   - legal status / jurisdiction
   - family or counterpart relation
   - source evidence

5. Bucket conservatively.
   - Put strong same-product or close active invention / utility candidates in `HIGH_RISK`.
   - Put weaker but supported candidates in `RELATED`.
   - Do not promote broad analogs, foreign-only context, old family records, or title-similar patents into `HIGH_RISK` without a product and claim/status bridge.

6. Preserve auditability.
   - Write trace notes with sources searched, candidate evidence, bucket reason, and stop reason.
   - Do not include hidden chain-of-thought.
   - Do not invent patent numbers.

## Failure Patterns To Avoid

- Treating visually similar products as the same product.
- Stopping at `NONE` just because there is no patent marking.
- Using design patents as substitutes for invention / utility patents.
- Promoting title-similar patents without product / owner / claim-status bridge.
- Expanding every family / counterpart record until the output becomes unusable.
- Writing a polished legal memo instead of returning normalized patent identifiers.

## Learning Rule

Skill updates may add reusable search protocol, verifier notes, bucket rules, or small answer-free tools.

Skill updates must not add:

- product-specific answer shortcuts
- expected patent numbers
- hidden target labels
- score-report-specific hacks
- private dataset text

The goal is better evidence discipline, not more output.
