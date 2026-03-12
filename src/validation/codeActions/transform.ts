import * as vscode from "vscode";
import { isOpenClawConfigDocument } from "../../utils";
import { fullDocumentRange } from "./path";
import { computeQuickFixText, isQuickFixPayload } from "./text";

export async function applyQuickFix(payload: unknown): Promise<void> {
  if (!isQuickFixPayload(payload)) {
    await vscode.window.showWarningMessage("OpenClaw quick fix payload is invalid.");
    return;
  }

  const uri = vscode.Uri.parse(payload.uri);
  const document = await vscode.workspace.openTextDocument(uri);
  if (!isOpenClawConfigDocument(document)) {
    await vscode.window.showWarningMessage(
      "OpenClaw quick fix can only be applied to openclaw.json files.",
    );
    return;
  }

  const nextText = computeQuickFixText(document.getText(), payload);
  if (nextText === null || nextText === document.getText()) {
    return;
  }

  const fullRange = fullDocumentRange(document);
  const edit = new vscode.WorkspaceEdit();
  edit.replace(document.uri, fullRange, nextText);
  await vscode.workspace.applyEdit(edit);
  await document.save();
}
