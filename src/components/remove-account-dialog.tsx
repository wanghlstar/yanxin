import { useEffect, useState } from "react";
import { LoaderCircle } from "lucide-react";
import { toast } from "sonner";
import { call } from "@/lib/api";
import { Alert, AlertDescription } from "./ui/alert";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import { Label } from "./ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import type { Account } from "@/lib/types";

export function RemoveAccountDialog({
  account,
  open,
  onOpenChange,
  onRemoved,
}: {
  account: Account | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRemoved: () => void;
}) {
  const [keepArchive, setKeepArchive] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (open) {
      setKeepArchive(true);
      setError("");
    }
  }, [open]);
  async function remove() {
    if (!account || busy) return;
    setBusy(true);
    setError("");
    try {
      await call("account_action", {
        id: account.id,
        remove: true,
        purge: !keepArchive,
      });
      onOpenChange(false);
      onRemoved();
      toast.success(
        keepArchive
          ? `已移除 ${account.email}，本地存档已保留`
          : `已移除 ${account.email}，本地存档已一并清除`,
      );
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!busy) onOpenChange(value);
      }}
    >
      <DialogContent
        showCloseButton={!busy}
        onEscapeKeyDown={(e) => {
          if (busy) e.preventDefault();
        }}
        onPointerDownOutside={(e) => {
          if (busy) e.preventDefault();
        }}
      >
        <DialogHeader>
          <DialogTitle>移除账号</DialogTitle>
          <DialogDescription>
            移除 {account?.email} 后将停止收取该账号邮件，并删除保存的登录凭据。
          </DialogDescription>
        </DialogHeader>
        <div className="flex items-start gap-2">
          <Checkbox
            id="remove-account-keep-archive"
            checked={keepArchive}
            disabled={busy}
            onCheckedChange={(value) => setKeepArchive(value === true)}
          />
          <Label htmlFor="remove-account-keep-archive">
            保留本地存档（正文、附件与 .eml 原件）
          </Label>
        </div>
        {keepArchive ? (
          <p className="text-sm text-muted-foreground">
            未存档的列表记录会清理，已有完整存档仍留在本机，可继续离线查看。
          </p>
        ) : (
          <Alert variant="destructive">
            <AlertDescription>
              该账号的本地存档、草稿与发送记录将一并删除，删除后无法恢复。
            </AlertDescription>
          </Alert>
        )}
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <DialogFooter>
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => onOpenChange(false)}
          >
            取消
          </Button>
          <Button
            variant="destructive"
            disabled={busy || !account}
            onClick={() => void remove()}
          >
            {busy && <LoaderCircle size={15} className="animate-spin" />}
            {busy
              ? "正在移除…"
              : keepArchive
                ? "移除账号，保留存档"
                : "移除账号并清除存档"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
