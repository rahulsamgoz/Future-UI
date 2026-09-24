import { useState } from "react";
import { newId } from "@ui-intelligence/protocol";
import type { RendererProps } from "@ui-intelligence/react";

/**
 * Profile form renderers. Editing state lives in the declared state adapter
 * so it transfers across representation switches and page-layout remounts.
 */
function useFormValue(props: RendererProps) {
  const initial = props.state
    ? (props.state.exportState() as { name?: string; email?: string; bio?: string })
    : ((props.data.value as { name?: string; email?: string; bio?: string }) ?? {});
  const [name, setName] = useState(initial.name ?? "");
  const [email, setEmail] = useState(initial.email ?? "");
  const [bio, setBio] = useState(initial.bio ?? "");
  return { name, setName, email, setEmail, bio, setBio };
}

export function FormStandard(props: RendererProps) {
  const f = useFormValue(props);
  const showBio = (props.properties.showBio as boolean) ?? true;
  if (props.data.status === "error") return <div className="state-error" data-testid="form-error">Profile could not be loaded.</div>;
  return (
    <form
      className="profile-form"
      data-testid="form-standard"
      onSubmit={(e) => {
        e.preventDefault();
        const action = props.actions["account.saveProfile@1"];
        void action?.invoke({ name: f.name, email: f.email, bio: f.bio }, { invocationId: newId("inv"), signal: new AbortController().signal });
      }}
    >
      <label>
        Name
        <input value={f.name} onChange={(e) => f.setName(e.target.value)} autoComplete="name" />
      </label>
      <label>
        Email
        <input value={f.email} onChange={(e) => f.setEmail(e.target.value)} type="email" autoComplete="email" />
      </label>
      {showBio && (
        <label>
          Bio
          <textarea value={f.bio} onChange={(e) => f.setBio(e.target.value)} rows={3} />
        </label>
      )}
      <button type="submit" className="btn primary">Save profile</button>
    </form>
  );
}

export function FormCompact(props: RendererProps) {
  const f = useFormValue(props);
  if (props.data.status === "error") return <div className="state-error" data-testid="form-error">Profile could not be loaded.</div>;
  return (
    <form
      className="profile-form compact"
      data-testid="form-compact"
      onSubmit={(e) => {
        e.preventDefault();
        const action = props.actions["account.saveProfile@1"];
        void action?.invoke({ name: f.name, email: f.email, bio: f.bio }, { invocationId: newId("inv"), signal: new AbortController().signal });
      }}
    >
      <div className="compact-row">
        <label>
          Name
          <input value={f.name} onChange={(e) => f.setName(e.target.value)} />
        </label>
        <label>
          Email
          <input value={f.email} onChange={(e) => f.setEmail(e.target.value)} type="email" />
        </label>
      </div>
      <button type="submit" className="btn primary compact">Save</button>
    </form>
  );
}
