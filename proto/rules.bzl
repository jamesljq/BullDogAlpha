load("@rules_go//proto:def.bzl", "go_proto_library")

# Custom macro representing the custom go_merge_choke_grpc compilation target,
# wrapping standard go_proto_library with rules_go's go_grpc compiler.
def go_merge_choke_grpc(name, importpath, proto, deps = [], **kwargs):
    go_proto_library(
        name = name,
        compilers = ["@rules_go//proto:go_grpc"],
        importpath = importpath,
        proto = proto,
        deps = deps,
        **kwargs
    )
