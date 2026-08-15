//! Team Execution Chain presets.
//!
//! Rust mirror of the TypeScript module `src/core/orchestration/team-chain.ts`.
//! A "chain" is an orchestration policy for a Team Run: how many delivery
//! stages, child agents, and verification gates are expected. A chain is NOT a
//! specialist — the root session keeps `specialistId: "team-agent-lead"` and
//! gains an optional `teamChainId` metadata field instead.
//!
//! Storage semantics:
//! - JSON field name: `teamChainId`; persistence column: `team_chain_id`.
//! - Omitted/legacy values stay NULL in storage and are *interpreted* as
//!   `full_delivery` when reading or displaying.
//!
//! API-parity tests keep this module aligned with the TypeScript one.

/// Specialist id of the root Team Lead session. The only session type that may
/// carry a `teamChainId`.
pub const TEAM_LEAD_SPECIALIST_ID: &str = "team-agent-lead";

/// Valid Team execution chain identifiers, in canonical order.
pub const TEAM_CHAIN_IDS: [&str; 3] = ["lightweight", "standard_delivery", "full_delivery"];

/// Legacy/omitted Team Runs behave as Full Delivery.
pub const DEFAULT_TEAM_CHAIN_ID: &str = "full_delivery";

/// Type guard for the three known chain identifiers.
pub fn is_team_chain_id(value: &str) -> bool {
    TEAM_CHAIN_IDS.contains(&value)
}

/// Normalize a raw persisted/request value: a valid chain ID passes through,
/// anything else becomes `None`, meaning "omitted — interpret as legacy Full
/// Delivery".
pub fn parse_team_chain_id(value: Option<&str>) -> Option<&str> {
    value.filter(|v| is_team_chain_id(v))
}

/// Interpret an omitted/legacy value as the default chain.
pub fn resolve_effective_team_chain_id(value: Option<&str>) -> &'static str {
    match value {
        Some(v) if is_team_chain_id(v) => match v {
            "lightweight" => "lightweight",
            "standard_delivery" => "standard_delivery",
            _ => "full_delivery",
        },
        _ => DEFAULT_TEAM_CHAIN_ID,
    }
}

/// Validation failure reasons, mirrored from the TypeScript union type.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TeamChainValidationError {
    InvalidValue,
    RequiresTeamLead,
    RequiresRootSession,
}

impl TeamChainValidationError {
    /// JSON-RPC invalid-params message, identical to the TypeScript backend.
    pub fn message(&self) -> String {
        match self {
            TeamChainValidationError::InvalidValue => {
                format!("teamChainId must be one of: {}", TEAM_CHAIN_IDS.join(", "))
            }
            TeamChainValidationError::RequiresTeamLead => {
                "teamChainId is only allowed on team-agent-lead sessions".to_string()
            }
            TeamChainValidationError::RequiresRootSession => {
                "teamChainId is only allowed on top-level team sessions".to_string()
            }
        }
    }
}

/// Validate a `session/new` chain assignment.
///
/// Rules (mirrored by the TypeScript backend):
/// - an omitted `teamChainId` is always allowed and persists as NULL;
/// - a provided value must be one of the three known IDs;
/// - `teamChainId` is only allowed on a top-level `team-agent-lead` session.
pub fn validate_team_chain_assignment(
    team_chain_id: Option<&str>,
    specialist_id: Option<&str>,
    parent_session_id: Option<&str>,
) -> Result<Option<String>, TeamChainValidationError> {
    let Some(raw) = team_chain_id else {
        return Ok(None);
    };
    if !is_team_chain_id(raw) {
        return Err(TeamChainValidationError::InvalidValue);
    }
    if specialist_id != Some(TEAM_LEAD_SPECIALIST_ID) {
        return Err(TeamChainValidationError::RequiresTeamLead);
    }
    if parent_session_id.is_some() {
        return Err(TeamChainValidationError::RequiresRootSession);
    }
    Ok(Some(raw.to_string()))
}

const LIGHTWEIGHT_POLICY: &str = "## Team Chain Policy: Lightweight\n\n\
This Team Run uses the Lightweight execution chain. Where this policy differs from the default full-delivery rules in your role prompt, this policy wins.\n\n\
- Delivery stages: Team Lead -> one implementation specialist -> Team Lead delivery.\n\
- Child agent shape: delegate to at most ONE child agent in total. No research wave, no parallel waves, no multi-specialist pipeline.\n\
- Verification: the single implementer verifies their own work with targeted evidence (focused tests, build, or a scoped manual check). Self-verification is valid evidence on this chain — do NOT spawn an independent QA or code-review agent.\n\
- Stop and escalate: if the work grows beyond one bounded change, needs another specialty, touches public APIs, database schema or migrations, security, payments, or needs broader verification — stop expanding, explain the newly discovered scope or risk, recommend a stronger chain, and ask the user to start a new Team Run with it.\n\
- Completion output: what changed, how the implementer verified it (concrete evidence), and any risks or follow-ups found.";

const STANDARD_DELIVERY_POLICY: &str = "## Team Chain Policy: Standard Delivery\n\n\
This Team Run uses the Standard Delivery execution chain. Where this policy differs from the default full-delivery rules in your role prompt, this policy wins.\n\n\
- Delivery stages: Team Lead -> one primary implementer -> one independent verifier -> Team Lead delivery.\n\
- Child agent shape: exactly one primary implementation specialist; at most two child sessions active at once. Do not open with a research wave; add research only if the affected area cannot be identified safely by the primary implementer.\n\
- Verification: after implementation, run exactly ONE independent verification stage. Choose the verifier deterministically: behavior or UI changes -> qa; code-structure or interface changes -> code-reviewer; when both apply -> qa. The verifier must produce concrete evidence (test output, inspection results), not a generic approval.\n\
- Stop and escalate: if risk expands (database schema or migrations, security, payments, cross-backend delivery, public APIs) or scope grows beyond one primary change — stop expanding, explain the newly discovered scope or risk, recommend a stronger chain, and ask the user to start a new Team Run with it.\n\
- Completion output: what changed, which independent verifier checked it, and the verification evidence.";

/// Resolve a chain ID into the concise policy prompt appended to the Team Lead
/// specialist prompt.
///
/// `full_delivery` and legacy/omitted values return `None`: the canonical
/// Agent Lead rules already encode Full Delivery, so nothing is appended and
/// legacy runs keep their exact historical prompt.
pub fn build_team_chain_policy_prompt(chain_id: Option<&str>) -> Option<&'static str> {
    match chain_id {
        Some("lightweight") => Some(LIGHTWEIGHT_POLICY),
        Some("standard_delivery") => Some(STANDARD_DELIVERY_POLICY),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn guards_accept_only_known_ids() {
        assert!(is_team_chain_id("lightweight"));
        assert!(is_team_chain_id("standard_delivery"));
        assert!(is_team_chain_id("full_delivery"));
        assert!(!is_team_chain_id(""));
        assert!(!is_team_chain_id("full"));
        assert!(!is_team_chain_id("FULL_DELIVERY"));
    }

    #[test]
    fn parse_normalizes_unknown_to_none() {
        assert_eq!(
            parse_team_chain_id(Some("lightweight")),
            Some("lightweight")
        );
        assert_eq!(parse_team_chain_id(Some("bogus")), None);
        assert_eq!(parse_team_chain_id(None), None);
    }

    #[test]
    fn resolve_effective_defaults_to_full_delivery() {
        assert_eq!(resolve_effective_team_chain_id(None), "full_delivery");
        assert_eq!(
            resolve_effective_team_chain_id(Some("bogus")),
            "full_delivery"
        );
        assert_eq!(
            resolve_effective_team_chain_id(Some("standard_delivery")),
            "standard_delivery"
        );
    }

    #[test]
    fn omitted_chain_is_always_allowed() {
        assert_eq!(validate_team_chain_assignment(None, None, None), Ok(None));
        assert_eq!(
            validate_team_chain_assignment(None, Some("researcher"), Some("parent")),
            Ok(None)
        );
    }

    #[test]
    fn invalid_value_rejected() {
        assert_eq!(
            validate_team_chain_assignment(Some("bogus"), Some(TEAM_LEAD_SPECIALIST_ID), None),
            Err(TeamChainValidationError::InvalidValue)
        );
    }

    #[test]
    fn requires_team_lead_specialist() {
        assert_eq!(
            validate_team_chain_assignment(Some("lightweight"), Some("researcher"), None),
            Err(TeamChainValidationError::RequiresTeamLead)
        );
        assert_eq!(
            validate_team_chain_assignment(Some("lightweight"), None, None),
            Err(TeamChainValidationError::RequiresTeamLead)
        );
    }

    #[test]
    fn requires_root_session() {
        assert_eq!(
            validate_team_chain_assignment(
                Some("standard_delivery"),
                Some(TEAM_LEAD_SPECIALIST_ID),
                Some("parent-1")
            ),
            Err(TeamChainValidationError::RequiresRootSession)
        );
    }

    #[test]
    fn valid_assignment_passes_through() {
        assert_eq!(
            validate_team_chain_assignment(
                Some("standard_delivery"),
                Some(TEAM_LEAD_SPECIALIST_ID),
                None
            ),
            Ok(Some("standard_delivery".to_string()))
        );
    }

    #[test]
    fn validation_order_prefers_invalid_value() {
        // Invalid value wins over team-lead/root checks, matching the TS order.
        assert_eq!(
            validate_team_chain_assignment(Some("bogus"), Some("researcher"), Some("parent")),
            Err(TeamChainValidationError::InvalidValue)
        );
    }

    #[test]
    fn policy_prompt_only_for_non_full_chains() {
        assert!(build_team_chain_policy_prompt(Some("lightweight")).is_some());
        assert!(build_team_chain_policy_prompt(Some("standard_delivery")).is_some());
        assert!(build_team_chain_policy_prompt(Some("full_delivery")).is_none());
        assert!(build_team_chain_policy_prompt(None).is_none());
    }

    #[test]
    fn policy_prompts_carry_chain_specific_rules() {
        let lightweight = build_team_chain_policy_prompt(Some("lightweight")).unwrap();
        assert!(lightweight.starts_with("## Team Chain Policy: Lightweight"));
        assert!(lightweight.contains("at most ONE child agent"));
        assert!(lightweight.contains("do NOT spawn an independent QA or code-review agent"));

        let standard = build_team_chain_policy_prompt(Some("standard_delivery")).unwrap();
        assert!(standard.starts_with("## Team Chain Policy: Standard Delivery"));
        assert!(standard.contains("exactly ONE independent verification stage"));
        assert!(standard.contains("when both apply -> qa"));
    }

    #[test]
    fn error_messages_match_contract() {
        assert_eq!(
            TeamChainValidationError::InvalidValue.message(),
            "teamChainId must be one of: lightweight, standard_delivery, full_delivery"
        );
        assert_eq!(
            TeamChainValidationError::RequiresTeamLead.message(),
            "teamChainId is only allowed on team-agent-lead sessions"
        );
        assert_eq!(
            TeamChainValidationError::RequiresRootSession.message(),
            "teamChainId is only allowed on top-level team sessions"
        );
    }
}
