// Thin re-alias of the kernel's backend_calls capability surface, so the rest
// of the backend depends on local names (Capabilities.CallRequest, …) rather
// than the versioned package path. Mirrors apps/wallet/backend/capabilities.
import NeutronCapabilities "mo:neutron-capabilities";

module {
    public type CallRequest = NeutronCapabilities.BackendCallRequestV1;
    public type CallError = NeutronCapabilities.BackendCallErrorV1;
    public type CallResult = NeutronCapabilities.BackendCallResultV1;
    public type BackendCalls = NeutronCapabilities.BackendCallsV1;
};
