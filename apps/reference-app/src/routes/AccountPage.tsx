import { useMemo, useRef, useState } from "react";
import { UiBoundary } from "@ui-intelligence/react";
import { newId } from "@ui-intelligence/protocol";
import {
  createAdminStatsBinding,
  createFormStateAdapter,
  createLabelBinding,
  createListStateAdapter,
  createProfileDataBinding,
  createSaveProfileAction,
  createTransactionsBinding,
  type Profile,
} from "../data/account.js";
import {
  accountPageContract,
  adminPanelContract,
  buttonContract,
  profileFormContract,
  transactionListContract,
} from "../contracts.js";
import { useAppServices } from "../Services.js";
import { PageComposer } from "../app/PageComposer.js";
import { useActivePreference, useActivePreferenceFor } from "../app/hooks.js";
import { appRendererMap } from "../kernel.js";
import { useFixture } from "./CatalogPage.js";

const INITIAL_PROFILE: Profile = { name: "Riley Chen", email: "riley@example.com", bio: "Product designer." };

export function AccountPage() {
  const { kernel } = useAppServices();
  const fixture = useFixture();
  const [savedToast, setSavedToast] = useState<string | null>(null);

  const formState = useRef(createFormStateAdapter(INITIAL_PROFILE));
  const listState = useRef(createListStateAdapter());

  const profileBinding = useMemo(() => createProfileDataBinding(fixture), [fixture]);
  const statsBinding = useMemo(() => createAdminStatsBinding(), []);
  const txBinding = useMemo(() => createTransactionsBinding(), []);

  const saveAction = useMemo(
    () => ({
      "account.saveProfile@1": createSaveProfileAction((p) => {
        setSavedToast(`Saved profile for ${p.name}`);
      }),
    }),
    []
  );

  const renderers = useMemo(() => appRendererMap(), [kernel]);
  const formPref = useActivePreference("account.profileForm");
  const txPref = useActivePreference("account.transactionList");
  const panelPref = useActivePreference("account.adminPanel");

  const regions: Record<string, React.ReactNode> = {
    profile: (
      <UiBoundary
        contract={profileFormContract}
        bindings={{ data: profileBinding, actions: saveAction, state: formState.current }}
        renderers={renderers}
        preferredRepresentation={formPref?.representation}
        preferredProperties={formPref?.properties}
      />
    ),
    // Locked slot: the admin panel keeps its registered content and position.
    admin: (
      <div className="locked-region" data-locked="true">
        <UiBoundary
          contract={adminPanelContract}
          bindings={{ data: statsBinding, actions: {} }}
          renderers={renderers}
          preferredRepresentation={panelPref?.representation}
          preferredProperties={panelPref?.properties}
        />
      </div>
    ),
    transactions: (
      <UiBoundary
        contract={transactionListContract}
        bindings={{ data: txBinding, actions: {}, state: listState.current }}
        renderers={renderers}
        preferredRepresentation={txPref?.representation}
        preferredProperties={txPref?.properties}
      />
    ),
  };

  return (
    <main className="page account">
      <header className="page-header">
        <h1>Account</h1>
        <p className="muted">
          The admin region is locked by the page contract. The transaction list is virtualized (partially observed).
        </p>
      </header>
      <PageComposer
        pageContract={accountPageContract}
        defaultLayout={{
          kind: "layout",
          nodeId: "root",
          type: "split@1",
          properties: { ratio: "50-50", orientation: "horizontal" },
          children: [
            { kind: "region", nodeId: "r-profile", slotId: "profile", entityId: "account.profileForm" },
            {
              kind: "layout",
              nodeId: "right-col",
              type: "stack@1",
              properties: { gap: "md", direction: "vertical" },
              children: [
                { kind: "region", nodeId: "r-admin", slotId: "admin", entityId: "account.adminPanel" },
                { kind: "region", nodeId: "r-tx", slotId: "transactions", entityId: "account.transactionList" },
              ],
            },
          ],
        }}
        regions={regions}
      />
      <section className="page-actions">
        <UiBoundary
          contract={buttonContract}
          bindings={{
            data: createLabelBinding("Export data"),
            actions: {
              "ui.action@1": {
                contract: { id: "ui.action", version: 1, schemaDigest: "sha256:ui-action-1" },
                invoke: async () => {
                  setSavedToast("Data export queued (host action)");
                  return { status: "succeeded", value: null };
                },
              },
            },
          }}
          instanceKey="account.exportButton"
          renderers={renderers}
        />
      </section>
      {savedToast && <div className="toast" role="status">{savedToast}</div>}
    </main>
  );
}

export function invocationHelp(): string {
  return newId("inv");
}
