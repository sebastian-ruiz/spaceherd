use clap::{Parser, Subcommand};

#[derive(Parser)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Add a note
    Add { text: String, #[arg(long)] tag: Vec<String> },
    /// List notes
    List(ListArgs),
}

#[derive(clap::Args)]
struct ListArgs {
    #[arg(long)]
    tag: Option<String>,
}

struct Note {
    text: String,
    tags: Vec<String>,
}

fn list(args: &ListArgs, mut notes: Vec<Note>) {
    if let Some(tag) = &args.tag {
        notes.retain(|n| n.tags.contains(tag));
    }
    for note in notes {
        println!("- {} [{}]", note.text, note.tags.join(", "));
    }
}

fn main() {
    let cli = Cli::parse();
    match cli.command {
        Command::Add { text, tag } => println!("added: {text} {tag:?}"),
        Command::List(args) => list(&args, Vec::new()),
    }
}
