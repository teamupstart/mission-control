export function NodeReviewPolicyEditor({ name, enabled, readOnly, onChange }: {
  name: string;
  enabled: boolean;
  readOnly: boolean;
  onChange: (enabled: boolean) => void;
}) {
  return (
    <div className="wf-node-review-policy">
      <label>
        <input
          type="checkbox"
          aria-label={`Recheck ${name} after repairs`}
          checked={enabled}
          disabled={readOnly}
          onChange={(event) => onChange(event.target.checked)}
        />
        <span>Recheck after repairs</span>
      </label>
      <p>Always review repaired submissions, overriding pass reuse in Settings.</p>
    </div>
  );
}
