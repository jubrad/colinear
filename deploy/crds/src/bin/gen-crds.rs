//! Print every colinear CRD as YAML. `bin/gen-crds` writes it into the chart,
//! or with `--check` fails if the chart's copy is out of date.
fn main() {
    print!("{}", coli_crds::crds_yaml());
}
