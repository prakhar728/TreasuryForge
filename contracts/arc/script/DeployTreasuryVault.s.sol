// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {TreasuryVault} from "../src/TreasuryVault.sol";

/**
 * @title DeployTreasuryVault
 * @notice Deploys TreasuryVault to Arc testnet
 * @dev Run: source ../../.env && forge script script/DeployTreasuryVault.s.sol:DeployTreasuryVault \
 *          --rpc-url $ARC_RPC_URL --broadcast
 */
contract DeployTreasuryVault is Script {
    function run() public {
        address usdc = vm.envAddress("ARC_USDC_ADDRESS");
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);

        console2.log("Deployer / Agent:", deployer);
        console2.log("USDC:", usdc);

        vm.startBroadcast(deployerKey);

        // Agent = deployer for MVP
        TreasuryVault vault = new TreasuryVault(usdc, deployer);

        vm.stopBroadcast();

        console2.log("--------------------------------------");
        console2.log("TreasuryVault deployed to:", address(vault));
        console2.log("--------------------------------------");
    }
}
