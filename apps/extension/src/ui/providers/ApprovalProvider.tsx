import { ApprovalContext, ApprovalContextType, useNavigation, useWallet } from '@qbit/wallet-state';
import { useRef } from 'react';

export function ApprovalProvider({ children }: { children: React.ReactNode }) {
  const wallet = useWallet();
  const nav = useNavigation();

  const getApproval = wallet.getApproval;
  // Both settle only the approval whose id the screen rendered. The background
  // compares the id and settles in one step, so an approval that replaced the
  // rendered one stays pending; the navigation home then shows it instead.
  const resolveApproval = async (approvalId: string | undefined, data?: any, stay = false, forceReject = false) => {
    const resolved = approvalId !== undefined && (await wallet.resolveApproval(approvalId, data, forceReject));
    if (stay) {
      return resolved;
    }
    setTimeout(() => {
      nav.navToRootHome();
    });
    return resolved;
  };

  const rejectApproval = async (approvalId: string | undefined, reason?: string, stay = false, isInternal = false) => {
    const rejected = approvalId !== undefined && (await wallet.rejectApproval(approvalId, reason, stay, isInternal));
    if (!stay) {
      nav.navToRootHome();
    }
    return rejected;
  };

  const selfRef = useRef<ApprovalContextType>({
    getApproval,
    resolveApproval,
    rejectApproval
  });

  const self = selfRef.current;

  return <ApprovalContext.Provider value={self}>{children}</ApprovalContext.Provider>;
}
