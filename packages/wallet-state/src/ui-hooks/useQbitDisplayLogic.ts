export function useQbitDisplayLogic(balance: string) {
  const totalAmountMainPart = balance.slice(0, -8)
  const totalAmountSubPart = balance.slice(-8)

  return {
    totalAmountMainPart,
    totalAmountSubPart,
  }
}
