import { useEffect, useRef } from "react";
import { mcpAuthorizationHeader, mcpEndpointUrl } from "../../lib/mcp-setup.ts";
import { Button } from "../ui/Button.tsx";
import { Field, Row } from "../ui/Field.tsx";
import { Input } from "../ui/Input.tsx";
import { MutedText } from "../ui/Text.tsx";
import { CopyValueButton } from "./CopyValueButton.tsx";
import { McpClientGuide } from "./McpClientGuide.tsx";

type Props = {
  origin: string;
  token: string;
  tokenName: string;
  onClose: () => void;
};

export function McpSetupHelp({ origin, token, tokenName, onClose }: Props) {
  const endpoint = mcpEndpointUrl(origin);
  const authorization = mcpAuthorizationHeader(token);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    rootRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  return (
    <div
      className="my-4 rounded-md border border-border bg-surface px-4 py-3"
      ref={rootRef}
      role="status"
    >
      <p>
        <strong>{tokenName}</strong>{" "}
        を発行しました。トークンはこの画面で一度だけ表示されます。
      </p>
      <MutedText className="mt-2">
        使うクライアントを選ぶと、貼り付け用の設定が出ます。ノートのブラウザ URL
        は <code className="font-mono">{"/n/{id}"}</code>（UUID）です。
        <code className="font-mono">{"/{shortId}"}</code> では開けません。
      </MutedText>

      <div className="mt-4 grid gap-3">
        <Field label="トークン">
          <Row>
            <Input
              className="min-w-0 flex-1 font-mono"
              readOnly={true}
              value={token}
            />
            <CopyValueButton value={token} />
          </Row>
        </Field>
        <Field label="エンドポイント">
          <Row>
            <Input
              className="min-w-0 flex-1 font-mono"
              readOnly={true}
              value={endpoint}
            />
            <CopyValueButton value={endpoint} />
          </Row>
        </Field>
        <Field label="Authorization">
          <Row>
            <Input
              className="min-w-0 flex-1 font-mono"
              readOnly={true}
              value={authorization}
            />
            <CopyValueButton value={authorization} />
          </Row>
        </Field>
      </div>

      <McpClientGuide origin={origin} token={token} />

      <Row className="mt-3">
        <Button onClick={onClose} variant="outline">
          閉じる
        </Button>
      </Row>
    </div>
  );
}
