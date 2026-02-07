import { render, screen } from "@testing-library/react";
import DepositUI from "../DepositUI";

describe("DepositUI", () => {
  it("renders connect state", () => {
    render(
      <DepositUI
        vaultAddress="0x0000000000000000000000000000000000000000"
        usdcAddress="0x0000000000000000000000000000000000000000"
        agentApiUrl=""
      />
    );

    expect(screen.getByText("TreasuryForge")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /connect wallet/i })).toBeInTheDocument();
  });
});
