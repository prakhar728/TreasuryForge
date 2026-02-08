// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {TreasuryVault} from "../src/TreasuryVault.sol";

/**
 * @title DeployTreasuryVaultBase
 * @notice Deploys TreasuryVault to Base Sepolia
 * @dev Run: forge script script/DeployTreasuryVaultBase.s.sol:DeployTreasuryVaultBase \
 *          --rpc-url $BASE_SEPOLIA_RPC_URL --broadcast --dotenv-path ../../.env
 */
contract DeployTreasuryVaultBase is Script {
    function run() public {
        address usdc = vm.envAddress("BASE_USDC_ADDRESS");
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);

        console2.log("Deployer / Agent:", deployer);
        console2.log("Base USDC:", usdc);

        vm.startBroadcast(deployerKey);

        // Agent = deployer for MVP
        TreasuryVault vault = new TreasuryVault(usdc, deployer);

        vm.stopBroadcast();

        console2.log("--------------------------------------");
        console2.log("Base TreasuryVault deployed to:", address(vault));
        console2.log("--------------------------------------");
    }
}
