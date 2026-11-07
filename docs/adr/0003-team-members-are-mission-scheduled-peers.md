# 3. Team members are peers scheduled by the mission, not delegated children

Date: 2026-11-07
Status: Accepted

A mission team's members are peers under the mission. The mission schedules their
work within its own concurrency cap and mission budget. The coordinator *requests*
work, and the mission admits and schedules it. Delegation limits (depth ≤ 2, ≤ 4
active child jobs per parent) govern only the subagents spawned inside one session.

Making members delegated children of the coordinator would look natural, but a
five-member team would already break the child-job limit. Every member's authority
would also become a narrowing of the coordinator's grant, and missions without a
coordinator (deterministic dependencies) would have no parent at all. Do not
"simplify" teams back into delegation trees.

Decided in [Team members are peers scheduled by the mission](https://github.com/talelk/brain/issues/10).
