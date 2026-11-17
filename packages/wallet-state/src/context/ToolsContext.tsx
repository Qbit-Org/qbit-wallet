/* eslint-disable indent */
import React, { useCallback, useContext, useRef, useState } from 'react'

type ToastFunction = (content: string) => void
type LoadingFunction = (visible: boolean, content?: string) => void

/**
 * How a toast is shown. `lasting`: long enough to read a warning the user
 * must not miss, with a control that closes it, and announced as an alert.
 */
export interface ToastOptions {
  lasting?: boolean
}

export interface ToolsContextType {
  toast: ToastFunction
  toastSuccess: ToastFunction
  toastError: ToastFunction
  toastWarning: (content: string, options?: ToastOptions) => void
  showLoading: LoadingFunction
  showTip: ToastFunction
  copyToClipboard: (text: string) => void
  openUrl: (url: string) => void
}

const initContext = {
  toast: (content: string) => {
    // todo
  },
  toastSuccess: (content: string) => {
    // todo
  },
  toastError: (content: string) => {
    // todo
  },
  toastWarning: (content: string) => {
    // todo
  },
  showLoading: () => {
    // todo
  },
  showTip: (content: string) => {
    // todo
  },
  copyToClipboard: (text: string) => {
    // todo
  },
  openUrl(url: string) {
    // todo
  },
}

export const ToolsContext = React.createContext<ToolsContextType>(initContext)

export function useTools() {
  const ctx = useContext(ToolsContext)
  return ctx
}
