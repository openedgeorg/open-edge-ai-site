# Storage and retention

Native session files stay on the runtime volume. The knowledge service does not mount that volume, and the web pod has no evidence egress in the base network policy.

Retention durations, region, encryption owner, and key owner are required production inputs. No value in this tree is an approved policy. `infra/runtime/retention-policy.schema.json` describes the shape and does not fill it in.

`scripts/history_lifecycle.py` reports deletion as unsupported. That is a failure when the policy requires deletion. It does not remove a peer session and it does not crypto-shred by default.

Evidence rows are not the same store as native history. An approved deletion policy has to name which store it covers before anyone claims data was removed.
